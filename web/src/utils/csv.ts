type CsvCell = string | number | null | undefined;

const escapeCell = (value: CsvCell): string => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export const toCsv = (headers: readonly string[], rows: readonly (readonly CsvCell[])[]): string =>
  [headers, ...rows].map((row) => row.map(escapeCell).join(',')).join('\r\n');

export const downloadCsv = (filename: string, content: string): void => {
  /** The BOM is what makes Excel read Lao and Thai text instead of mojibake. */
  const url = URL.createObjectURL(new Blob([`${content}`], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};
