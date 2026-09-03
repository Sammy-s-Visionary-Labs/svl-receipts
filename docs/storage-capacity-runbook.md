# Storage capacity monitoring runbook (RA-209)

**Owner:** Purshottam Singh. The GitHub repository collaborator named by
`SVL_STORAGE_ALERT_ASSIGNEE` is the operational recipient and must be kept current.

The daily **Storage capacity monitor** GitHub Actions workflow measures aggregate receipt Storage
in both `svl-receipts-dev` and `svl-receipts-prod`. It records object count and average stored-object
size, plus confirmed page and receipt averages. It never reads or reports receipt IDs, object names,
signed URLs, image contents, or credentials.

Supabase bills Storage usage in GB-hours and Free-plan quotas are organization-wide. The default
configuration therefore adds dev and production usage when both projects belong to the same
Supabase organization. See Supabase's [Storage size usage](https://supabase.com/docs/guides/platform/manage-your-usage/storage-size)
and [billing](https://supabase.com/docs/guides/platform/billing-on-supabase) documentation.

## One-time setup

1. Deploy `20260903192238_ra209_storage_capacity_snapshot.sql` to dev first, then production. The
   migration creates `svl_ops.storage_capacity_snapshot()` and the restricted
   `svl_storage_monitor` role. The role is `NOLOGIN` by default.
2. In each project's Supabase SQL Editor, assign a different generated password:

   ```sql
   alter role svl_storage_monitor login password '<unique password from the team vault>';
   ```

3. In **Connect → Session pooler**, copy that project's connection parameters. Build a connection
   URL for the custom role using the pooler's exact host, port, and project suffix. The username is
   `svl_storage_monitor.<project-ref>`. URL-encode the password before placing it in a URL. Test the
   connection without printing it.
4. Add the URLs to GitHub **Settings → Secrets and variables → Actions → Secrets**:

   - `SVL_DEV_DATABASE_URL`
   - `SVL_PROD_DATABASE_URL`

5. Add Actions variables:

   - `SVL_STORAGE_ALERT_ASSIGNEE`: an active GitHub username with access to this repository.
   - `SVL_STORAGE_QUOTA_BYTES`: `1000000000` for the current 1 GB quota. Change it when the plan or
     purchased quota changes.
   - `SVL_STORAGE_QUOTA_SCOPE`: `shared` when both projects are in one organization; use `separate`
     only if the projects have independent organization quotas.
6. Run **Actions → Storage capacity monitor → Run workflow** with no synthetic percentage. Confirm
   both environment rows and the combined row appear in the workflow summary.

The custom database role can execute only the aggregate snapshot. It cannot select from
`storage.objects` or `receipt_pages`, and app roles cannot call the snapshot.

## Alert verification

From **Actions → Storage capacity monitor → Run workflow**, run these values in order:

1. `70` — creates or reopens an assigned TEST warning issue.
2. `85` — updates the same issue and adds an escalation comment.
3. `95` — updates the same issue to critical and adds an escalation comment.
4. `0` — closes the TEST issue.

The live measurements remain visible and unchanged during these synthetic checks. Confirm the
assignee receives the expected GitHub notification. A scheduled live run uses no synthetic value
and maintains a separate `[RA-209] Storage capacity alert` issue.

## Threshold response

| Level | Trigger | Required response |
| --- | ---: | --- |
| Warning | 70% | Check object growth and average receipt size; confirm resize/compression and retention jobs are healthy. |
| High | 85% | Decide and schedule the managed Storage upgrade; investigate unexpected dev/test growth. |
| Critical | 95% | Upgrade capacity immediately and pause nonessential test uploads until headroom is restored. |

Never delete confirmed receipt objects directly to clear an alert. Receipt content must follow the
verified retention/purge workflow so database state is changed only after Storage deletion succeeds.

## Where to inspect metrics

- GitHub **Actions → Storage capacity monitor → latest run → Summary** contains every measurement.
- The open `[RA-209] Storage capacity alert` issue contains the latest alerting snapshot and history
  of severity changes.
- Supabase organization **Usage / Storage** is the billing source of truth and should be used to
  reconcile a surprising result.

The workflow runs daily at 09:17 UTC. GitHub scheduled workflows can be delayed; a missing or failed
run opens/updates `[RA-209] Storage capacity monitor failed` when the workflow reaches the script.
GitHub also reports workflow-level failures, such as a runner outage, in Actions.

## Troubleshooting

- **Monitor failure issue:** confirm both Actions secrets exist, both custom roles are `LOGIN`, the
  migration is applied, and Supabase is reachable. Rotate a leaked or uncertain password immediately.
- **Permission denied:** do not grant table access. Reapply/inspect the migration and verify the URL
  uses `svl_storage_monitor`, not an application or owner role.
- **Unexpected combined percentage:** confirm both projects are in the same Supabase organization and
  `SVL_STORAGE_QUOTA_SCOPE=shared`. If they are in different organizations, set `separate`.
- **Quota changed:** update `SVL_STORAGE_QUOTA_BYTES`, run the workflow manually, and update this
  runbook and `docs/environments.md` in the same change.
- **Assignee left the team:** change `SVL_STORAGE_ALERT_ASSIGNEE` before removing their repository
  access and run the 70% synthetic check again.
