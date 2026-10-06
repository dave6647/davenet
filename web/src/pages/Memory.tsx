import { useEffect, useState } from 'react';
import { api, qs } from '../api.ts';
import { Badge, Card, ConfirmButton, ErrorBox, Field, Loading, Markdown, Modal, PageHead, TextArea, TextInput, useAction } from '../components/ui.tsx';
import { fmtDateTime } from '../format.ts';
import { useApi } from '../live.ts';
import { setQuery, useRoute } from '../router.ts';

interface Tree {
  areas: string[];
  editable: string[];
  files: { path: string; size: number; modified: string }[];
}

const AREA_LABELS: Record<string, string> = {
  strategy: 'Strategie',
  opportunities: 'Opportunities',
  projects: 'Projekte',
  research: 'Research',
  finance: 'Finanzen',
  decisions: 'Entscheidungen',
  knowledge: 'Wissen',
  audit: 'Audit',
};

export function Memory() {
  const route = useRoute();
  const tree = useApi<Tree>('/api/memory/tree', ['memory', 'opportunity', 'job']);
  const [filter, setFilter] = useState('');
  const [newFile, setNewFile] = useState(false);
  const selected = route.query.get('file');
  if (tree.error) return <ErrorBox error={tree.error} />;
  if (!tree.data) return <Loading />;
  const files = tree.data.files.filter((f) => !filter || f.path.toLowerCase().includes(filter.toLowerCase()));

  return (
    <>
      <PageHead
        title="Unternehmensgedächtnis"
        subtitle="Persistentes Wissen liegt im Dateisystem, nicht im LLM-Kontext (Konzept §13). Agents erhalten nur benötigte Ausschnitte."
        actions={<button onClick={() => setNewFile(true)}>+ Notiz / Wissensdokument</button>}
      />
      <div className="grid" style={{ gridTemplateColumns: 'minmax(260px, 1fr) minmax(0, 2.4fr)' }}>
        <Card title="Dateien">
          <TextInput value={filter} onChange={setFilter} placeholder="Filtern …" />
          <div className="scroll-y" style={{ maxHeight: '70vh', marginTop: 8 }}>
            {tree.data.areas.map((area) => {
              const list = files.filter((f) => f.path.startsWith(`${area}/`));
              return (
                <div key={area} style={{ marginBottom: 10 }}>
                  <div className="row">
                    <strong>/{area}</strong>
                    <span className="muted small">{AREA_LABELS[area]}</span>
                    {tree.data!.editable.includes(area) && <Badge kind="info">editierbar</Badge>}
                  </div>
                  <ul className="list-plain small" style={{ marginTop: 4, paddingLeft: 10 }}>
                    {list.map((f) => (
                      <li key={f.path}>
                        <button className="link" style={{ fontWeight: f.path === selected ? 700 : 400, textAlign: 'left' }} onClick={() => setQuery({ file: f.path })}>
                          {f.path.slice(area.length + 1)}
                        </button>
                      </li>
                    ))}
                    {!list.length && <li className="muted">leer</li>}
                  </ul>
                </div>
              );
            })}
          </div>
        </Card>
        <div>{selected ? <FileView path={selected} editable={tree.data.editable.includes(selected.split('/')[0])} onDeleted={() => setQuery({ file: null })} /> : <Card><div className="empty">Datei auswählen. Tipp: Beginne mit <button className="link" onClick={() => setQuery({ file: 'strategy/strategie.md' })}>strategy/strategie.md</button> – die Strategie steuert, was Scout und Analyst suchen.</div></Card>}</div>
      </div>
      {newFile && <NewFileDialog onClose={() => setNewFile(false)} />}
    </>
  );
}

function FileView({ path, editable, onDeleted }: { path: string; editable: boolean; onDeleted: () => void }) {
  const file = useApi<{ path: string; content: string }>(`/api/memory/file${qs({ path })}`, ['memory']);
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState('');
  const { run, busy } = useAction();
  useEffect(() => {
    if (file.data && !edit) setText(file.data.content);
  }, [file.data, edit]);
  useEffect(() => setEdit(false), [path]);
  if (file.error) return <ErrorBox error={file.error} />;
  if (!file.data) return <Loading />;
  const save = () =>
    run(async () => {
      await api.put('/api/memory/file', { path, content: text });
      setEdit(false);
      file.reload();
    }, 'Gespeichert');
  const remove = () =>
    run(async () => {
      await api.del(`/api/memory/file${qs({ path })}`);
      onDeleted();
    }, 'Gelöscht');
  const isMd = path.endsWith('.md');
  return (
    <Card
      title={<span className="mono">{path}</span>}
      actions={
        editable ? (
          edit ? (
            <>
              <button className="small" onClick={() => setEdit(false)}>
                Abbrechen
              </button>
              <button className="small primary" disabled={busy} onClick={save}>
                Speichern
              </button>
            </>
          ) : (
            <>
              <button className="small" onClick={() => setEdit(true)}>
                Bearbeiten
              </button>
              {path !== 'strategy/strategie.md' && (
                <ConfirmButton className="small danger" confirm={`${path} löschen?`} onConfirm={remove}>
                  Löschen
                </ConfirmButton>
              )}
            </>
          )
        ) : (
          <Badge>nur lesbar</Badge>
        )
      }
    >
      {edit ? <TextArea value={text} onChange={setText} rows={28} /> : isMd ? <Markdown text={file.data.content} /> : <pre>{file.data.content}</pre>}
    </Card>
  );
}

function NewFileDialog({ onClose }: { onClose: () => void }) {
  const [area, setArea] = useState('knowledge');
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const { run, busy } = useAction();
  const clean = name.trim().replace(/[^a-zA-Z0-9äöüÄÖÜß _.-]/g, '').replace(/\s+/g, '-');
  const path = `${area}/${clean.endsWith('.md') ? clean : `${clean}.md`}`;
  const save = () =>
    run(async () => {
      await api.put('/api/memory/file', { path, content: content || `# ${name}\n` });
      onClose();
      setQuery({ file: path });
    }, 'Angelegt');
  return (
    <Modal
      title="Neues Dokument"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Abbrechen</button>
          <button className="primary" disabled={busy || !clean} onClick={save}>
            Anlegen
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Bereich">
          <select value={area} onChange={(e) => setArea(e.target.value)}>
            <option value="knowledge">Wissen (wird Agents als Kontext angeboten)</option>
            <option value="decisions">Entscheidungen</option>
            <option value="strategy">Strategie</option>
          </select>
        </Field>
        <Field label="Dateiname" help={path}>
          <TextInput value={name} onChange={setName} placeholder="z. B. zielgruppen" />
        </Field>
        <Field label="Inhalt (Markdown)" full>
          <TextArea value={content} onChange={setContent} rows={10} />
        </Field>
      </div>
      <p className="small muted">Stand {fmtDateTime(new Date().toISOString())}</p>
    </Modal>
  );
}
