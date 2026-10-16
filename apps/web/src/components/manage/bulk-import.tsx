'use client';

import {
  importColumns,
  type BulkImportPreviewDto,
  type BulkImportResultDto,
  type ImportSampleKind,
} from '@storeline/shared';
import { useMutation } from '@tanstack/react-query';
import { Download, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { Alert, Button, cx, Dialog, SelectField } from '@/components/ui';
import { api, downloadFile, errorMessage } from '@/lib/api';

/** Base64 of a picked file (4 MB at most), for the upload endpoints. */
export async function fileToBase64(file: File): Promise<string> {
  if (file.size > 4 * 1024 * 1024) throw new Error('The file is too big (4 MB at most).');
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000)
    bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** "Download the sample file": an Excel file with the right headings and an example row. */
export function SampleFileButton({ kind }: { kind: ImportSampleKind }) {
  const download = useMutation({
    mutationFn: () => downloadFile(`/imports/${kind}/sample.xlsx`, `sma-${kind}-sample.xlsx`),
  });
  return (
    <div>
      <Button
        variant="secondary"
        size="sm"
        busy={download.isPending}
        icon={<Download className="size-4" aria-hidden />}
        onClick={() => download.mutate()}
      >
        Download the sample file
      </Button>
      {download.isError && <Alert tone="error">{errorMessage(download.error)}</Alert>}
    </div>
  );
}

/**
 * Create many businesses (platform) or stores (one business) from an Excel/CSV file: pick the
 * file, check every row, then create the good ones. Rows with problems are listed with why.
 */
export function BulkImportDialog({
  kind,
  businessId: fixedBusinessId,
  businessChoices = [],
  onClose,
  onDone,
}: {
  kind: 'businesses' | 'stores';
  businessId?: string;
  /** Stores: the businesses to choose from when no business is fixed. */
  businessChoices?: Array<{ id: string; name: string }>;
  onClose: () => void;
  onDone: () => void;
}) {
  const [businessId, setBusinessId] = useState(fixedBusinessId ?? businessChoices[0]?.id ?? '');
  const input = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [result, setResult] = useState<BulkImportResultDto | null>(null);
  const base = kind === 'businesses' ? '/imports/businesses' : `/imports/stores/${businessId}`;
  const columns = importColumns(kind);
  const what = kind === 'businesses' ? 'businesses' : 'stores';
  const preview = useMutation({
    mutationFn: async (file: File) =>
      api<BulkImportPreviewDto>(`${base}/preview`, {
        method: 'POST',
        body: { fileName: file.name, contentBase64: await fileToBase64(file) },
      }),
  });
  const p = preview.data;
  const good = (p?.rows ?? []).filter((r) => r.errors.length === 0);
  const run = useMutation({
    mutationFn: () =>
      api<BulkImportResultDto>(base, {
        method: 'POST',
        body: { rows: good.map((r) => ({ row: r.row, values: r.values })) },
      }),
    onSuccess: (r) => {
      setResult(r);
      onDone();
    },
  });
  const shown = columns.filter((c) => p?.mapping[c.field]).slice(0, 5);
  return (
    <Dialog
      open
      onClose={onClose}
      title={kind === 'businesses' ? 'Add businesses from Excel' : 'Add stores from Excel'}
      wide
    >
      <div className="flex flex-col gap-4">
        {result ? (
          <>
            <Alert tone={result.failed.length ? 'warning' : 'success'} title="Upload finished">
              {result.created} {what} created
              {result.failed.length ? `, ${result.failed.length} could not be created:` : '.'}
              {result.failed.length > 0 && (
                <ul className="mt-1 list-disc pl-5 text-sm">
                  {result.failed.slice(0, 20).map((f) => (
                    <li key={f.row}>
                      Row {f.row}: {f.error}
                    </li>
                  ))}
                </ul>
              )}
            </Alert>
            <Button onClick={onClose}>Done</Button>
          </>
        ) : (
          <>
            <p className="text-muted">
              Fill the sample file (one {kind === 'businesses' ? 'business' : 'store'} per row) and
              upload it as Excel (.xlsx) or CSV. Required columns:{' '}
              {columns
                .filter((c) => c.required)
                .map((c) => c.label)
                .join(', ')}
              . Every row is checked before anything is created.
            </p>
            {kind === 'stores' && !fixedBusinessId && businessChoices.length > 1 && (
              <SelectField
                label="Add the stores to"
                value={businessId}
                onChange={(e) => {
                  setBusinessId(e.target.value);
                  preview.reset();
                  setFileName('');
                }}
              >
                {businessChoices.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </SelectField>
            )}
            <SampleFileButton kind={kind} />
            <input
              ref={input}
              type="file"
              accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  setFileName(f.name);
                  preview.mutate(f);
                }
                e.target.value = '';
              }}
            />
            <Button
              variant="secondary"
              icon={<Upload className="size-5" aria-hidden />}
              busy={preview.isPending}
              onClick={() => input.current?.click()}
            >
              {fileName ? `Choose another file (${fileName})` : 'Choose the filled file'}
            </Button>
            {preview.isError && <Alert tone="error">{errorMessage(preview.error)}</Alert>}
            {p && (
              <>
                <p className="text-sm text-muted">
                  {good.length} of {p.rows.length} rows are ready
                  {p.rows.length - good.length > 0
                    ? `; ${p.rows.length - good.length} have problems and will be skipped`
                    : ''}
                  {p.truncated ? ' · only the first 1,000 rows are used' : ''}.
                </p>
                <div className="max-h-80 overflow-auto rounded-2xl border border-line">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead className="sticky top-0 bg-surface-2">
                      <tr className="text-left">
                        <th className="px-2 py-2 font-semibold">Row</th>
                        {shown.map((c) => (
                          <th key={c.field} className="px-2 py-2 font-semibold">
                            {c.label}
                          </th>
                        ))}
                        <th className="px-2 py-2 font-semibold">Check</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.rows.map((r) => (
                        <tr
                          key={r.row}
                          className={cx(
                            'border-t border-line',
                            r.errors.length > 0 && 'bg-warning-surface/50',
                          )}
                        >
                          <td className="px-2 py-1.5 text-muted">{r.row}</td>
                          {shown.map((c) => (
                            <td key={c.field} className="max-w-40 truncate px-2 py-1.5">
                              {r.values[c.field] ?? ''}
                            </td>
                          ))}
                          <td className="px-2 py-1.5">
                            {r.errors.length > 0 ? (
                              <span className="text-danger">{r.errors.join('; ')}</span>
                            ) : (
                              <span className="text-success">Ready</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {run.isError && <Alert tone="error">{errorMessage(run.error)}</Alert>}
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" onClick={onClose}>
                    Cancel
                  </Button>
                  <Button
                    disabled={good.length === 0}
                    busy={run.isPending}
                    onClick={() => run.mutate()}
                  >
                    Create {good.length} {what}
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
