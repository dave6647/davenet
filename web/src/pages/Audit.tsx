import { useState } from 'react';
import type { AuditEntry } from '../../../shared/domain.ts';
import { qs } from '../api.ts';
import { Badge, Card, ErrorBox, Loading, PageHead, Select, TextInput } from '../components/ui.tsx';
import { fmtDateTime } from '../format.ts';
import { useApi } from '../live.ts';

const ENTITIES = ['job', 'opportunity', 'task', 'approval', 'provider', 'agent', 'department', 'model', 'schedule', 'settings', 'memory', 'job_type'];

function entityLink(e: AuditEntry): string | null {
  if (!e.entity_id) return null;
  switch (e.entity_type) {
    case 'job':
      return `#/jobs/${e.entity_id}`;
    case 'opportunity':
      return `#/opportunities/${e.entity_id}`;
    case 'task':
      return `#/opportunities/${e.entity_id.split('-').slice(0, 2).join('-')}`;
    case 'provider':
      return `#/providers/${e.entity_id}`;
    case 'agent':
      return `#/agents/${e.entity_id}`;
    default:
      return null;
  }
}

export function Audit() {
  const [entity, setEntity] = useState<string | null>(null);
  const [actor, setActor] = useState('');
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const { data, error } = useApi<{ items: AuditEntry[]; total: number }>(
    `/api/audit${qs({ entity_type: entity, actor: actor.trim() || null, limit: 100, offset: page * 100 })}`,
    ['audit'],
  );
  return (
    <>
      <PageHead title="Audit-Log" subtitle="Nachvollziehbarkeit aller Aktionen von Owner, System und Agents – inkl. Approval-Level (Konzept §14)." />
      <div className="row">
        <div style={{ width: 220 }}>
          <Select value={entity} allowEmpty="alle Objekte" options={ENTITIES.map((e) => ({ value: e, label: e }))} onChange={(v) => { setEntity(v); setPage(0); }} />
        </div>
        <div style={{ width: 220 }}>
          <TextInput value={actor} onChange={(v) => { setActor(v); setPage(0); }} placeholder="Akteur (owner, system, agent:…)" />
        </div>
      </div>
      <Card>
        <ErrorBox error={error} />
        {!data ? (
          <Loading />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Zeit</th>
                  <th>Akteur</th>
                  <th>Aktion</th>
                  <th>Objekt</th>
                  <th>Level</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((e) => {
                  const link = entityLink(e);
                  const details = JSON.stringify(e.details);
                  return (
                    <tr key={e.id}>
                      <td className="small nowrap">{fmtDateTime(e.ts)}</td>
                      <td className="small">{e.actor}</td>
                      <td className="small">{e.action}</td>
                      <td className="small">
                        {e.entity_type}
                        {e.entity_id ? ' ' : ''}
                        {link ? <a href={link}>{e.entity_id}</a> : e.entity_id}
                      </td>
                      <td>
                        <Badge kind={e.level >= 3 ? 'err' : e.level === 2 ? 'warn' : e.level === 1 ? 'info' : undefined}>L{e.level}</Badge>
                      </td>
                      <td className="small mono wrap-anywhere" style={{ maxWidth: 480, cursor: details.length > 120 ? 'pointer' : undefined }} onClick={() => setOpen(open === e.id ? null : e.id)}>
                        {details === '{}' ? '' : open === e.id ? <pre>{JSON.stringify(e.details, null, 2)}</pre> : details.slice(0, 120) + (details.length > 120 ? ' …' : '')}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!data.items.length && <div className="empty">Keine Einträge.</div>}
            <div className="row" style={{ marginTop: 10 }}>
              <span className="muted small">{data.total} Einträge</span>
              <span className="spacer" />
              <button className="small" disabled={page === 0} onClick={() => setPage(page - 1)}>
                ← neuer
              </button>
              <button className="small" disabled={(page + 1) * 100 >= data.total} onClick={() => setPage(page + 1)}>
                älter →
              </button>
            </div>
          </div>
        )}
      </Card>
    </>
  );
}
