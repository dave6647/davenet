import { useState } from 'react';
import type { Artifact } from '../../../shared/domain.ts';
import { fmtDateTime } from '../format.ts';
import { useApi } from '../live.ts';
import { Badge, ErrorBox, Loading, Markdown, Modal } from './ui.tsx';

const KIND_LABELS: Record<string, string> = {
  scan_report: 'Scan-Bericht',
  screening_note: 'Screening',
  research_report: 'Recherchebericht',
  evaluation: 'Bewertung',
  spec: 'MVP-Spezifikation',
  implementation_report: 'Implementierung',
  review: 'Review',
  cost_report: 'Kostenbericht',
  audit_report: 'Audit-Bericht',
  briefing: 'Executive Briefing',
  directive_plan: 'Auftragsplanung',
  custom_result: 'Ergebnis',
  raw_output: 'Rohausgabe',
};
export const artifactKindLabel = (k: string) => KIND_LABELS[k] ?? k;

export function ArtifactViewer({ id, onClose }: { id: number; onClose: () => void }) {
  const { data, error } = useApi<{ artifact: Artifact; content: string }>(`/api/artifacts/${id}`);
  return (
    <Modal title={data?.artifact.title ?? 'Artefakt'} onClose={onClose} wide>
      <ErrorBox error={error} />
      {!data ? (
        <Loading />
      ) : (
        <>
          <div className="small muted">
            {artifactKindLabel(data.artifact.kind)} · {fmtDateTime(data.artifact.created_at)} · <span className="mono">company/{data.artifact.path}</span>
          </div>
          {data.artifact.format === 'json' ? <pre>{data.content}</pre> : <Markdown text={data.content} />}
        </>
      )}
    </Modal>
  );
}

export function ArtifactList({ artifacts }: { artifacts: Artifact[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!artifacts.length) return <div className="muted small">Keine Artefakte.</div>;
  return (
    <>
      <ul className="list-plain">
        {artifacts.map((a) => (
          <li key={a.id}>
            <button className="link" onClick={() => setOpen(a.id)}>
              {a.title}
            </button>{' '}
            <Badge>{artifactKindLabel(a.kind)}</Badge> <span className="small muted">{fmtDateTime(a.created_at)}</span>
            {a.summary && <div className="small muted">{a.summary.slice(0, 220)}</div>}
          </li>
        ))}
      </ul>
      {open != null && <ArtifactViewer id={open} onClose={() => setOpen(null)} />}
    </>
  );
}
