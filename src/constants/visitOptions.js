// Single source of truth for the purpose/relationship choices used by
// RegisterPage, GatePage (walk-in), and VisitsPage (filter dropdown).
// Previously each page kept its own copy — they'd drifted out of sync
// (GatePage's walk-in list had "General Visit" twice and was missing
// "PTA Meeting" entirely), so data entered from one entry point couldn't
// be filtered correctly by a UI built assuming the other's list.

export const PURPOSE_OPTIONS = [
  "General Visit",
  "PTA Meeting",
  "Academic Concerns",
  "Medical",
  "Financial",
  "Pickup / Leave",
  "Other",
];

export const RELATIONSHIP_OPTIONS = [
  "Parent / Guardian",
  "Sibling",
  "Relative",
  "Family Friend",
  "Other",
];
