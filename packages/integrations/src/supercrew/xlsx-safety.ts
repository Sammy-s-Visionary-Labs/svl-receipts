import { inflateRawSync } from "node:zlib";

export const SUPERCREW_XLSX_LIMITS = {
  fileBytes: 10 * 1024 * 1024,
  expandedBytes: 30 * 1024 * 1024,
  zipMembers: 1000,
  sheets: 100,
  rowsPerSheet: 25000,
  cells: 300000,
} as const;

/** Check ZIP expansion before handing the document to a general-purpose workbook reader. */
export function assertSafeSupercrewXlsx(bytes: Uint8Array): void {
  if (bytes.byteLength > SUPERCREW_XLSX_LIMITS.fileBytes)
    throw new Error("Excel file exceeds the 10 MB import limit.");
  const zip = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (zip.length < 22 || zip.readUInt32LE(0) !== 0x04034b50)
    throw new Error("Expected an unencrypted XLSX file.");
  let end = -1;
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 65557); offset--) {
    if (
      zip.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + zip.readUInt16LE(offset + 20) === zip.length
    ) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new Error("Invalid XLSX ZIP directory.");
  const members = zip.readUInt16LE(end + 10);
  const directorySize = zip.readUInt32LE(end + 12);
  const directoryStart = zip.readUInt32LE(end + 16);
  if (
    zip.readUInt16LE(end + 4) !== 0 ||
    zip.readUInt16LE(end + 6) !== 0 ||
    zip.readUInt16LE(end + 8) !== members ||
    members === 65535 ||
    directoryStart === 0xffffffff ||
    directorySize === 0xffffffff
  ) {
    throw new Error("Multi-volume and ZIP64 Excel files are not supported.");
  }
  if (
    members < 1 ||
    members > SUPERCREW_XLSX_LIMITS.zipMembers ||
    directoryStart + directorySize !== end
  )
    throw new Error("XLSX archive exceeds the supported directory limits.");
  let offset = directoryStart;
  let expandedBytes = 0;
  let cells = 0;
  let hasContentTypes = false;
  let hasWorkbook = false;
  const names = new Set<string>();
  for (let member = 0; member < members; member++) {
    if (offset + 46 > end || zip.readUInt32LE(offset) !== 0x02014b50)
      throw new Error("Invalid XLSX ZIP member.");
    const flags = zip.readUInt16LE(offset + 8);
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const expandedSize = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (
      next > end ||
      nameLength < 1 ||
      nameLength > 512 ||
      compressedSize === 0xffffffff ||
      expandedSize === 0xffffffff ||
      zip.readUInt16LE(offset + 34) !== 0
    )
      throw new Error("Invalid XLSX member bounds.");
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (
      names.has(name) ||
      name.includes("\\") ||
      name.startsWith("/") ||
      name.split("/").includes("..") ||
      name.includes("\0")
    )
      throw new Error("Invalid or duplicated XLSX member name.");
    names.add(name);
    if ((flags & 0x41) !== 0 || ![0, 8].includes(method))
      throw new Error("Encrypted or unsupported XLSX compression.");
    if (/vbaproject|externallinks|activex|embeddings/i.test(name))
      throw new Error("Macros, external workbook links, and embedded objects are not accepted.");
    expandedBytes += expandedSize;
    if (expandedBytes > SUPERCREW_XLSX_LIMITS.expandedBytes)
      throw new Error("Expanded Excel file exceeds the 30 MB import limit.");
    if (localOffset + 30 > directoryStart || zip.readUInt32LE(localOffset) !== 0x04034b50)
      throw new Error("Invalid XLSX local member.");
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (
      dataStart + compressedSize > directoryStart ||
      zip.readUInt16LE(localOffset + 8) !== method ||
      (zip.readUInt16LE(localOffset + 6) & 0x41) !== 0 ||
      zip.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8") !== name
    )
      throw new Error("Invalid XLSX compressed member bounds.");
    const compressed = zip.subarray(dataStart, dataStart + compressedSize);
    let expanded: Buffer;
    try {
      expanded =
        method === 0
          ? compressed
          : inflateRawSync(compressed, { maxOutputLength: Math.max(1, expandedSize) });
    } catch {
      throw new Error("XLSX member is damaged or exceeds its declared expansion limit.");
    }
    if (expanded.length !== expandedSize)
      throw new Error("XLSX member expansion does not match its declared size.");
    if (name === "[Content_Types].xml") {
      hasContentTypes = true;
      if (/macroEnabled|vbaProject|externalLink|activeX/i.test(expanded.toString("utf8")))
        throw new Error("Only plain XLSX workbooks are accepted.");
    }
    if (name === "xl/workbook.xml") {
      hasWorkbook = true;
      let sheets = 0;
      for (const _match of expanded.toString("utf8").matchAll(/<sheet\b/g)) {
        sheets++;
        if (sheets > SUPERCREW_XLSX_LIMITS.sheets)
          throw new Error("Excel file has too many worksheets.");
      }
    }
    if (/^xl\/worksheets\/[^/]+\.xml$/.test(name)) {
      const xml = expanded.toString("utf8");
      for (const row of xml.matchAll(/<row\b[^>]*\br="(\d+)"/g)) {
        if (Number(row[1]) > SUPERCREW_XLSX_LIMITS.rowsPerSheet)
          throw new Error("Excel worksheet exceeds the 25,000 row limit.");
      }
      for (const _match of xml.matchAll(/<c\b/g)) {
        cells++;
        if (cells > SUPERCREW_XLSX_LIMITS.cells)
          throw new Error("Excel file exceeds the supported cell count.");
      }
    }
    offset = next;
  }
  if (offset !== end || !hasContentTypes || !hasWorkbook)
    throw new Error("Expected a complete XLSX workbook.");
}
