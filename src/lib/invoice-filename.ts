const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const BRANCH_PREFIXES: Record<number, string> = {
  1: 'JinJawLTD',
  2: 'JinJawArabiaSARL',
};

/** A stable filename for PDFs rendered by either production company branch. */
export function invoicePdfFilename(branchId: number, issueDate: string): string {
  const branch = BRANCH_PREFIXES[branchId] ?? 'Company';
  const match = /^(\d{4})-(\d{2})/.exec(issueDate);
  const monthIndex = match ? Number(match[2]) - 1 : -1;
  const month = MONTH_NAMES[monthIndex] ?? 'Unknown_Month';
  const year = match?.[1] ?? 'Unknown_Year';
  return `${branch}_Invoice_${month}_${year}.pdf`;
}
