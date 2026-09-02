import * as React from "react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

export type Column<T> = {
  key: string;
  header: string;
  cell: (row: T) => React.ReactNode;
  /** Dropped from the stacked rendering — for columns that only earn their
   *  space in a table, such as a redundant id. */
  hideOnNarrow?: boolean;
};

/**
 * One component for every tabular view in the panel.
 *
 * Both renderings are emitted and a container query hides one, so the switch
 * needs no JavaScript and no device guess — a table inside a narrow column
 * stacks correctly even on a wide screen. The hidden rendering is
 * aria-hidden so assistive technology reads each row once.
 *
 * The container is the nearest `@container` ancestor, which Panel provides.
 */
export function DataList<T>({ columns, rows, rowKey, empty }: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  empty: string;
}) {
  if (rows.length === 0) {
    return <p className="text-body text-muted-foreground">{empty}</p>;
  }
  const stacked = columns.filter(c => !c.hideOnNarrow);
  return (
    <>
      {/* narrow: stacked rows */}
      <ul className="flex flex-col gap-2 @md:hidden">
        {rows.map(row => (
          <li key={rowKey(row)} className="rounded-md border border-border p-2.5">
            <dl className="flex flex-col gap-1">
              {stacked.map(col => (
                <div key={col.key} className="flex items-baseline justify-between gap-3">
                  <dt className="text-label uppercase text-ink-dim">{col.header}</dt>
                  <dd className="min-w-0 text-right text-body">{col.cell(row)}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>

      {/* wide: a real table */}
      <div className="hidden @md:block" aria-hidden="true">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map(col => <TableHead key={col.key}>{col.header}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(row => (
              <TableRow key={rowKey(row)}>
                {columns.map(col => <TableCell key={col.key}>{col.cell(row)}</TableCell>)}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
