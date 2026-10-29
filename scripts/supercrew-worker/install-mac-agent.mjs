import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseProductionEnvironment } from "./mac-service.mjs";

export const MAC_AGENT_LABEL = "com.svl.labor-worker";
export const RELEASE_FILES = Object.freeze([
  "browser.mjs",
  "core.mjs",
  "hosted.mjs",
  "mac-service.mjs",
  "session.mjs",
  "worker.mjs",
  "package.json",
  "package-lock.json",
]);
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const xml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
const absolute = (value) =>
  typeof value === "string" && isAbsolute(value) && !/[\r\n\0]/.test(value);

export function launchAgentPlist({ nodePath, releaseDirectory, installationRoot }) {
  if (![nodePath, releaseDirectory, installationRoot].every(absolute))
    throw new Error("LaunchAgent paths must be absolute.");
  const args = [
    nodePath,
    join(releaseDirectory, "mac-service.mjs"),
    "--config",
    join(installationRoot, "production.env"),
    "--runtime",
    join(installationRoot, "runtime"),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${MAC_AGENT_LABEL}</string>
  <key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
  <key>WorkingDirectory</key><string>${xml(join(installationRoot, "runtime"))}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PLAYWRIGHT_BROWSERS_PATH</key><string>${xml(join(releaseDirectory, "browsers"))}</string>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>LANG</key><string>en_US.UTF-8</string>
  </dict>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>ExitTimeOut</key><integer>30</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
`;
}

async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Worker directory must not be a symlink.");
  await chmod(directory, 0o700);
}

async function privateFile(filename, contents) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function productionSettings(envFile, appOrigin) {
  const info = await lstat(envFile);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new Error("Production environment must be a private regular file (chmod 600).");
  const text = await readFile(envFile, "utf8");
  const env = parseProductionEnvironment(text);
  if (env.LABOR_APP_URL !== appOrigin)
    throw new Error("Production app origin does not match the reviewed plan.");
  return { text, env };
}

export async function prepareMacWorker(options) {
  const {
    outputDirectory,
    envFile,
    appOrigin,
    sourceRoot = sourceDirectory,
    userHome = homedir(),
    nodePath = process.execPath,
    npmCli = resolve(dirname(nodePath), "../lib/node_modules/npm/bin/npm-cli.js"),
  } = options;
  const installationRoot = join(userHome, "Library", "Application Support", "SVL Labor Worker");
  if (![outputDirectory, envFile, sourceRoot, userHome, nodePath, npmCli].every(absolute))
    throw new Error("Preparation requires absolute paths.");
  await productionSettings(envFile, appOrigin);
  await access(nodePath);
  await access(npmCli);
  const files = {};
  for (const name of RELEASE_FILES) files[name] = hash(await readFile(join(sourceRoot, name)));
  const releaseId = `worker-${hash(JSON.stringify(files)).slice(0, 16)}`;
  const releaseDirectory = join(installationRoot, "releases", releaseId);
  const plan = {
    version: 1,
    releaseId,
    files,
    nodePath,
    npmCli,
    userHome,
    appOrigin,
    installationRoot,
    releaseDirectory,
    plistPath: join(userHome, "Library", "LaunchAgents", `${MAC_AGENT_LABEL}.plist`),
  };
  await mkdir(outputDirectory, { mode: 0o700 });
  await privateDirectory(join(outputDirectory, "release"));
  for (const name of RELEASE_FILES) {
    await copyFile(join(sourceRoot, name), join(outputDirectory, "release", name));
    await chmod(join(outputDirectory, "release", name), 0o600);
  }
  await privateFile(join(outputDirectory, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  await privateFile(join(outputDirectory, `${MAC_AGENT_LABEL}.plist`), launchAgentPlist(plan));
  return plan;
}

function installEnvironment(plan, browserDirectory) {
  return {
    HOME: plan.userHome,
    PATH: `${dirname(plan.nodePath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: "en_US.UTF-8",
    TMPDIR: join(plan.installationRoot, "tmp"),
    npm_config_cache: join(plan.installationRoot, "npm-cache"),
    PLAYWRIGHT_BROWSERS_PATH: browserDirectory,
  };
}

function runProcess(executable, args, options = {}) {
  return new Promise((resolveResult, reject) => {
    // Child output can contain installation paths, but never receives worker credentials.
    const child = spawn(executable, args, { ...options, stdio: options.stdio ?? "inherit" });
    child.once("error", () => reject(new Error("Worker setup command could not start.")));
    child.once("exit", (code) => resolveResult(code ?? 1));
  });
}

async function readPlan(preparedDirectory) {
  const plan = JSON.parse(await readFile(join(preparedDirectory, "plan.json"), "utf8"));
  if (
    plan.version !== 1 ||
    !/^worker-[a-f0-9]{16}$/.test(plan.releaseId) ||
    ![plan.nodePath, plan.npmCli, plan.userHome].every(absolute) ||
    plan.installationRoot !==
      join(plan.userHome, "Library", "Application Support", "SVL Labor Worker") ||
    plan.releaseDirectory !== join(plan.installationRoot, "releases", plan.releaseId) ||
    plan.plistPath !== join(plan.userHome, "Library", "LaunchAgents", `${MAC_AGENT_LABEL}.plist`) ||
    JSON.stringify(Object.keys(plan.files)) !== JSON.stringify(RELEASE_FILES)
  )
    throw new Error("Invalid prepared worker plan.");
  for (const name of RELEASE_FILES)
    if (hash(await readFile(join(preparedDirectory, "release", name))) !== plan.files[name])
      throw new Error("Prepared worker files changed; prepare a fresh plan.");
  if (`worker-${hash(JSON.stringify(plan.files)).slice(0, 16)}` !== plan.releaseId)
    throw new Error("Prepared worker release identity changed.");
  return plan;
}

/** Copies only reviewed runtime files. It never loads launchd or connects Supercrew. */
export async function installPreparedMacWorker(preparedDirectory, envFile, operations = {}) {
  const run = operations.runProcess ?? runProcess;
  const plan = await readPlan(preparedDirectory);
  const { text } = await productionSettings(envFile, plan.appOrigin);
  const uid = operations.uid ?? process.getuid();
  if (
    (await run("/bin/launchctl", ["print", `gui/${uid}/${MAC_AGENT_LABEL}`], {
      stdio: "ignore",
    })) === 0
  )
    throw new Error(
      "Stop the installed LaunchAgent with launchctl bootout before installing or reconnecting.",
    );
  await privateDirectory(plan.installationRoot);
  const marker = join(plan.installationRoot, "installation.json");
  try {
    const previous = JSON.parse(await readFile(marker, "utf8"));
    if (previous.appOrigin !== plan.appOrigin)
      throw new Error(
        "This worker directory belongs to a different app origin. Preserve its session and use a separate reviewed installation.",
      );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const name of ["runtime", "releases", "tmp", "npm-cache"])
    await privateDirectory(join(plan.installationRoot, name));
  const temporary = join(plan.installationRoot, "releases", `.${plan.releaseId}-${randomUUID()}`);
  await privateDirectory(temporary);
  try {
    for (const name of RELEASE_FILES) {
      await copyFile(join(preparedDirectory, "release", name), join(temporary, name));
      await chmod(join(temporary, name), 0o600);
    }
    const env = installEnvironment(plan, join(temporary, "browsers"));
    if (
      await run(
        plan.nodePath,
        [plan.npmCli, "ci", "--prefix", temporary, "--ignore-scripts", "--no-audit", "--no-fund"],
        { env, cwd: temporary },
      )
    )
      throw new Error(
        "Pinned worker dependency installation failed; the existing agent was not replaced.",
      );
    if (
      await run(
        plan.nodePath,
        [join(temporary, "node_modules/playwright/cli.js"), "install", "chromium"],
        { env, cwd: temporary },
      )
    )
      throw new Error(
        "Pinned worker Chromium installation failed; the existing agent was not replaced.",
      );
    if (
      await run(
        plan.nodePath,
        [
          "--input-type=module",
          "-e",
          "const {chromium}=await import('@playwright/test'); const browser=await chromium.launch({headless:true}); await browser.close();",
        ],
        { env, cwd: temporary },
      )
    )
      throw new Error("Installed Chromium did not pass its offline startup check.");
    try {
      await lstat(plan.releaseDirectory);
      throw new Error(
        "This release is already installed. Review the existing installation or prepare changed worker files.",
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await rename(temporary, plan.releaseDirectory);
    await privateFile(join(plan.installationRoot, "production.env"), text);
    await privateFile(marker, `${JSON.stringify(plan, null, 2)}\n`);
    await mkdir(dirname(plan.plistPath), { recursive: true, mode: 0o700 });
    await privateFile(plan.plistPath, launchAgentPlist(plan));
    return plan;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (
      !["--prepare", "--install", "--env-file", "--origin", "--node", "--npm-cli"].includes(
        argv[index],
      ) ||
      !argv[index + 1] ||
      options[argv[index]]
    )
      throw new Error(
        "Use --prepare DIRECTORY --env-file FILE --origin HTTPS_ORIGIN [--node ABS_NODE --npm-cli ABS_NPM_CLI], or --install DIRECTORY --env-file FILE.",
      );
    options[argv[index]] = argv[index + 1];
  }
  if (!options["--env-file"] || Boolean(options["--prepare"]) === Boolean(options["--install"]))
    throw new Error("Choose exactly one of --prepare or --install and provide --env-file.");
  if (process.platform !== "darwin")
    throw new Error("The production LaunchAgent installer requires macOS.");
  const plan = options["--prepare"]
    ? await prepareMacWorker({
        outputDirectory: resolve(options["--prepare"]),
        envFile: resolve(options["--env-file"]),
        appOrigin: options["--origin"],
        nodePath: options["--node"] ?? process.execPath,
        ...(options["--npm-cli"] ? { npmCli: options["--npm-cli"] } : {}),
      })
    : await installPreparedMacWorker(resolve(options["--install"]), resolve(options["--env-file"]));
  console.log(
    JSON.stringify(
      {
        prepared: Boolean(options["--prepare"]),
        releaseDirectory: plan.releaseDirectory,
        plistPath: plan.plistPath,
        nodePath: plan.nodePath,
        runtime: join(plan.installationRoot, "runtime"),
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error(
      "Worker setup did not complete. Check private file permissions, the reviewed origin, the prepared plan, and whether an existing agent is stopped. Credentials were not printed.",
    );
    process.exitCode = 1;
  });
