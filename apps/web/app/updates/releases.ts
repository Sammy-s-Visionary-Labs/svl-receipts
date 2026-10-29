type UpdateKind = "Added" | "Updated" | "Removed" | "Fixed";
type ReleaseDay = {
  date: string;
  label: string;
  changes: { kind: UpdateKind; text: string }[];
};

// Keep dated, shipped changes here, newest first. Dates use America/New_York.
export const releaseWeeks: { weekOf: string; label: string; days: ReleaseDay[] }[] = [
  {
    weekOf: "2026-10-26",
    label: "Week of October 26, 2026",
    days: [
      {
        date: "2026-10-29",
        label: "October 29",
        changes: [
          {
            kind: "Added",
            text: "Labor Hours and Jobs now share Supercrew imports, daily job allocations, weekly pay estimates, and reviewed Housecall job links. Original Timesheet and Notes workbooks are available to download.",
          },
          {
            kind: "Added",
            text: "Review labor by job, period, and worker, then approve and send a cost summary to Housecall Job Inputs → Materials. Sending requires a separate manager action.",
          },
          {
            kind: "Added",
            text: "Hours with missing rates, unconfirmed job links, or unresolved allocation stay on hold while complete hours can be approved. Duplicate labor uploads are blocked, with verification and manager review for uncertain send results.",
          },
          {
            kind: "Added",
            text: "Daily, weekly, biweekly, and custom 1–365-day Supercrew downloads, with a configurable start time and recent-days review window.",
          },
          {
            kind: "Added",
            text: "The Mac download worker catches up on missed reports when the computer is awake, online, and logged in. Completed import batches are retained after interruptions.",
          },
          {
            kind: "Fixed",
            text: "Confirmed worker name variants combine for daily lunch deductions, weekly overtime, and job costs. Mitchell and Mitchell Relford now count as one worker.",
          },
          {
            kind: "Updated",
            text: "Grandmas breakfast is classified as a supplier stop for Sandman and follows the existing vendor-stop allocation rules.",
          },
          {
            kind: "Added",
            text: "Live Housecall job suggestions as you type a name or job number.",
          },
          {
            kind: "Fixed",
            text: "Individual and bulk job selection, plus automatic refresh of outdated job details.",
          },
          { kind: "Updated", text: "Receipts and emailed PDFs now support up to 10 pages." },
          {
            kind: "Updated",
            text: "Email settings shows connection status and pending or failed imports only.",
          },
          { kind: "Added", text: "Updates page for managers and administrators." },
          {
            kind: "Removed",
            text: "Duplicate History sidebar link. All history remains on the receipts page.",
          },
        ],
      },
      {
        date: "2026-10-27",
        label: "October 27",
        changes: [
          {
            kind: "Added",
            text: "Credit/debit controls for receipts and individual materials. Credits reduce Housecall job costs.",
          },
          { kind: "Updated", text: "Older receipts rechecked for credit/debit type." },
          {
            kind: "Updated",
            text: "Receipt list shows sender names or Email, dates beside age, red Debit and green Credit labels.",
          },
          {
            kind: "Fixed",
            text: "Zero quantities and unit costs are accepted. Zero-quantity lines are excluded from Housecall.",
          },
          {
            kind: "Fixed",
            text: "Improved extraction to keep customer notes, pickup instructions and ticket references out of materials.",
          },
          {
            kind: "Updated",
            text: "Job details show readable status and dates instead of internal codes.",
          },
          {
            kind: "Fixed",
            text: "Pending approved exports can resume without repeating completed uploads or costs.",
          },
          {
            kind: "Removed",
            text: "Field confidence and Signals columns from the receipt list; details remain inside each receipt.",
          },
          {
            kind: "Removed",
            text: "Manual bulk classification button. Receipts are classified automatically.",
          },
        ],
      },
    ],
  },
];
