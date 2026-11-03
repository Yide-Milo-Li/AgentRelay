"use client";
import { useEffect, useRef, useState } from "react";
import { Copy, Check, Download, Link2, RotateCcw, Trash2, ChevronLeft, Ellipsis, Info, FileText, Code2, FileDown, Reply, NotebookPen, GitBranch, GitCommitHorizontal } from "lucide-react";
import { useLang } from "@/components/providers/LanguageProvider";
import { RouteFull, RouteMini, type RouteRow } from "@/features/handoffs/components/RouteStrip";
import { copyText } from "@/shared/browser/clipboard";
import { formatDay } from "@/shared/formatting/date";
import { type Handoff } from "@/shared/contracts/handoffs";
import type { DeviceIndex } from "@/shared/formatting/device-identity";
import { resolveProject, type ProjectIndex } from "@/shared/formatting/project-identity";
import { hasShortcutLayer, SHORTCUTS } from "@/shared/browser/keyboard-shortcuts";
import { useKeyboardShortcuts } from "@/shared/hooks/use-keyboard-shortcuts";
import { ShortcutHint } from "@/components/ui/ShortcutHint";
import { MarkdownViewer } from "./MarkdownViewer";
import AttachmentGallery from "./AttachmentGallery";
import { ProjectTag } from "./ProjectTag";
import CompleteWithNoteDialog from "./CompleteWithNoteDialog";
import { checkoutCommand, shortCommit } from "../git-commands";

/** One handoff in the thread list: the server's thread entry, or a sample row. */
export type ThreadEntry = RouteRow & { id: string; title: string; createdAt: number };

/**
 * `thread` holds the active handoffs of this handoff's thread, oldest first, including this one; it is empty when the
 * handoff neither replies to another nor has replies. `onStatus` takes a receipt only when completing.
 */
/** Pixels scrolled before the pinned header starts to fade, and the downward travel over which it fades out completely. */
const HEAD_FADE_START = 24, HEAD_FADE_DISTANCE = 160;

type Props = { row: Handoff; thread: readonly ThreadEntry[]; devices: DeviceIndex; projects: ProjectIndex; demo: boolean; busy: boolean; characters: boolean; chosen: boolean;
  onStatus: (status: string, result?: string) => void; onDelete: () => void; onBack: () => void; onReply: () => void; onOpen: (id: string) => void; notify: (message: string) => void };

export default function HandoffDetail({ row, thread, devices, projects, demo, busy, characters, chosen, onStatus, onDelete, onBack, onReply, onOpen, notify }: Props) {
  const { t, locale, errorText } = useLang();
  const [confirmDelete, setConfirmDelete] = useState(false), [menu, setMenu] = useState(false), [copied, setCopied] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false), [commandCopied, setCommandCopied] = useState(false);
  const command = checkoutCommand(row);
  const menuRef = useRef<HTMLDivElement>(null);
  const article = useRef<HTMLElement>(null), moreButton = useRef<HTMLButtonElement>(null), cancelDelete = useRef<HTMLButtonElement>(null);
  const lines = row.content.split("\n"), project = resolveProject(projects, row.projectId, row.project);
  // Text actions only ever carry the prompt text; a handoff made of images alone has nothing for them to act on.
  const images = row.attachments.length, textless = row.content === "";
  const [viewMode, setViewMode] = useState<"markdown" | "raw">(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("agentrelay_prompt_view");
      if (saved === "markdown" || saved === "raw") return saved;
    }
    return "markdown";
  });
  function changeView(mode: "markdown" | "raw") {
    setViewMode(mode);
    try { localStorage.setItem("agentrelay_prompt_view", mode); } catch {}
  }
  // The detail pane scrolls on its own (the page on phones). The pinned header gains its hairline once text slides under it,
  // then fades as the reader moves down into the prompt and returns with any scroll back up. Written straight to the
  // element once per frame, so scrolling never re-renders the detail.
  const head = useRef<HTMLElement>(null);
  useEffect(() => {
    const header = head.current, pane = article.current?.closest<HTMLElement>(".detail-pane");
    if (!header) return;
    const offset = () => pane && getComputedStyle(pane).overflowY !== "visible" ? pane.scrollTop : window.scrollY;
    let last = offset(), hidden = 0, frame = 0;
    const paint = () => {
      frame = 0;
      const top = offset();
      // Downward travel accumulates and upward travel gives it back; near the top the header can never be more hidden than the reader has scrolled.
      hidden = Math.min(Math.max(hidden + top - last, 0), HEAD_FADE_DISTANCE, Math.max(top - HEAD_FADE_START, 0));
      last = top;
      const progress = hidden / HEAD_FADE_DISTANCE, fade = progress * progress * (3 - 2 * progress);
      header.style.setProperty("--fade", fade.toFixed(3));
      header.toggleAttribute("data-stuck", top > 4);
      header.toggleAttribute("data-faded", fade > 0.5);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };
    paint();
    pane?.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("scroll", schedule, { passive: true });
    return () => { cancelAnimationFrame(frame); pane?.removeEventListener("scroll", schedule); window.removeEventListener("scroll", schedule); };
  }, []);
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false); };
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    document.addEventListener("pointerdown", close);
    return () => { document.removeEventListener("pointerdown", close); };
  }, [menu]);
  useEffect(() => { if (confirmDelete) cancelDelete.current?.focus(); }, [confirmDelete]);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1800); return () => clearTimeout(timer); }, [copied]);
  useEffect(() => { if (!commandCopied) return; const timer = setTimeout(() => setCommandCopied(false), 1800); return () => clearTimeout(timer); }, [commandCopied]);
  async function copyCommand() { if (!command) return; try { await copyText(command); setCommandCopied(true); notify(t.git.copied); } catch (e) { notify(errorText(e)); } }

  async function copy() { if (textless) { notify(t.images.nothingToCopy); return; } try { await copyText(row.content); setCopied(true); notify(t.toastCopied); } catch (e) { notify(errorText(e)); } }
  function changeStatusWithShortcut(expected: string, next: string) {
    const detail = article.current;
    // A row the user picked (J/K, click, link) counts as deliberate; the fallback preview left after a status change does not,
    // so a repeated key cannot act on whatever row slid into view.
    if (row.status !== expected || busy || demo || !detail?.getClientRects().length || !(chosen || detail.contains(document.activeElement)) || hasShortcutLayer()) return false;
    onStatus(next);
    return true;
  }
  useKeyboardShortcuts({
    claim: () => changeStatusWithShortcut("ready", "claimed"),
    complete: () => changeStatusWithShortcut("claimed", "done"),
    copy: () => {
      if (!article.current?.getClientRects().length || hasShortcutLayer() || textless) return false;
      void copy(); return true;
    },
    escape: () => {
      if (noteOpen || document.querySelector("dialog[open]") || !article.current?.getClientRects().length) return false;
      if (menu) setMenu(false);
      else if (confirmDelete) setConfirmDelete(false);
      else return false;
      moreButton.current?.focus(); return true;
    },
  }, { characters, withinLayer: true });
  async function link() { try { await copyText(`${location.origin}/?handoff=${row.id}`); notify(t.toastLinkCopied); } catch (e) { notify(errorText(e)); } }
  function download(format: "md" | "txt" = "md") {
    // Persisted prompts use an authenticated attachment response to avoid Blob lifecycle races.
    const a = document.createElement("a"), ext = format === "md" ? "md" : "txt", mime = format === "md" ? "text/markdown" : "text/plain";
    a.href = demo ? `data:${mime};charset=utf-8,${encodeURIComponent(row.content)}` : `/api/handoffs/${row.id}/download?format=${ext}`;
    a.download = `${row.title.replace(/[<>:"/\\|?*]/g, "_").slice(0, 80)}.${ext}`;
    document.body.appendChild(a); a.click(); a.remove();
  }

  return <article ref={article} className="detail">
    <button className="link back" onClick={onBack}><ChevronLeft size={16} />{t.back}</button>
    <header ref={head} className="detail-head">
      <h1>{row.title}</h1>
      <div className="actions">
        <button className="btn primary" onClick={copy} disabled={textless} title={textless ? t.images.nothingToCopy : images ? t.images.textOnly(images) : undefined} data-done={copied || undefined} aria-keyshortcuts={characters ? SHORTCUTS.copy.aria : undefined}>{copied ? <Check size={16} /> : <Copy size={16} />}{t.copyPrompt}{characters && <ShortcutHint action="copy" />}</button>
        {row.status === "ready" && <button className="btn" disabled={busy || demo} aria-keyshortcuts={characters ? SHORTCUTS.claim.aria : undefined} onClick={() => onStatus("claimed")}>{t.claim}{characters && <ShortcutHint action="claim" />}</button>}
        {row.status === "claimed" && <button className="btn" disabled={busy || demo} aria-keyshortcuts={characters ? SHORTCUTS.complete.aria : undefined} onClick={() => onStatus("done")}><Check size={16} />{t.complete}{characters && <ShortcutHint action="complete" />}</button>}
        <span className="actions-gap" />
        {!demo && <button className="icon" title={t.receipts.reply} aria-label={t.receipts.reply} onClick={onReply}><Reply size={17} /></button>}
        {!demo && <button className="icon" title={t.copyLink} aria-label={t.copyLink} onClick={link}><Link2 size={17} /></button>}
        <button className="icon" disabled={textless} title={textless ? t.images.nothingToCopy : images ? `${t.download} — ${t.images.textOnly(images)}` : t.download} aria-label={t.download} onClick={() => download("md")}><Download size={17} /></button>
        {!demo && <div className="menu-wrap" ref={menuRef} data-menu-open={menu || undefined}>
          <button ref={moreButton} className="icon" title={t.more} aria-label={t.more} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(v => !v)}><Ellipsis size={17} /></button>
          {menu && <div className="menu" role="menu" data-shortcut-layer>
            {row.status === "claimed" && <button role="menuitem" disabled={busy} onClick={() => { setMenu(false); setNoteOpen(true); }}><NotebookPen size={15} />{t.receipts.completeWithNote}</button>}
            {row.status !== "ready" && <button role="menuitem" disabled={busy} onClick={() => { setMenu(false); onStatus("ready"); }}><RotateCcw size={15} />{t.requeue}</button>}
            <button role="menuitem" disabled={textless} title={images ? t.images.textOnly(images) : undefined} onClick={() => { setMenu(false); download("txt"); }}><FileDown size={15} />{t.downloadTxt}</button>
            <button role="menuitem" className="danger" disabled={busy} onClick={() => { setMenu(false); setConfirmDelete(true); }}><Trash2 size={15} />{t.deleteHandoff}</button>
          </div>}
        </div>}
      </div>
    </header>

    {confirmDelete && <div className="confirm" role="alert" data-shortcut-layer>
      <span>{t.deleteConfirm}</span>
      <button ref={cancelDelete} className="btn" onClick={() => { setConfirmDelete(false); moreButton.current?.focus(); }}>{t.cancel}</button>
      <button className="btn danger" disabled={busy} onClick={onDelete}>{t.deleteYes}</button>
    </div>}

    <RouteFull row={row} devices={devices} />

    {/* The sender's code state as plain text: never a link, and the copied commands quote every value. */}
    {command && <section className="code-state" aria-labelledby="code-state-title">
      <span id="code-state-title" className="prompt-header-title">{t.git.codeState}</span>
      <span className="code-state-ref">
        {row.branch && <span title={t.git.branch(row.branch)}><GitBranch size={14} aria-hidden="true" /><code>{row.branch}</code></span>}
        {row.baseCommit && <span title={t.git.commit(row.baseCommit)}><GitCommitHorizontal size={14} aria-hidden="true" /><code aria-label={t.git.commit(row.baseCommit)}>{shortCommit(row.baseCommit)}</code></span>}
      </span>
      <button className="icon" title={t.git.copyCommand} aria-label={t.git.copyCommand} data-done={commandCopied || undefined} onClick={copyCommand}>{commandCopied ? <Check size={16} /> : <Copy size={16} />}</button>
      <p className="attach-note">{t.git.note}</p>
    </section>}

    <div className="prompt-header">
      <span className="prompt-header-title">{t.promptText}</span>
      <div className="prompt-header-actions">
        <div className="prompt-tabs" role="tablist" aria-label={t.promptViewMode}>
        <button
          type="button"
          role="tab"
          aria-selected={viewMode === "markdown"}
          className="prompt-tab"
          data-active={viewMode === "markdown" || undefined}
          onClick={() => changeView("markdown")}
        >
          <FileText size={13} aria-hidden="true" />
          <span>{t.viewMarkdown}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={viewMode === "raw"}
          className="prompt-tab"
          data-active={viewMode === "raw" || undefined}
          onClick={() => changeView("raw")}
        >
          <Code2 size={13} aria-hidden="true" />
          <span>{t.viewRaw}</span>
        </button>
      </div>
      </div>
    </div>
    {images > 0 && !textless && <p className="attach-note">{t.images.textOnly(images)}</p>}
    <div className="prompt" data-mode={viewMode} tabIndex={0} aria-label={t.promptText}>
      {textless ? <p className="prompt-empty">{t.images.imagesOnly}</p> : viewMode === "markdown" ? (
        <MarkdownViewer content={row.content} />
      ) : (
        <pre>{lines.map((line, i) => <div className="ln" key={i}><span aria-hidden="true" className="ln-n">{i + 1}</span><span className="ln-t">{line || "\u200b"}</span></div>)}</pre>
      )}
    </div>

    <AttachmentGallery attachments={row.attachments} basePath={`/api/handoffs/${encodeURIComponent(row.id)}/attachments`} />

    {row.result && <section className="receipt" aria-labelledby="receipt-title">
      <div className="prompt-header">
        <span id="receipt-title" className="prompt-header-title">{row.status === "done" ? t.receipts.result : t.receipts.previousResult}</span>
      </div>
      {/* Same view mode as the prompt above, and the same inert rendering: the receipt is untrusted text too. */}
      <div className="prompt" data-mode={viewMode} tabIndex={0} aria-labelledby="receipt-title">
        {viewMode === "markdown" ? <MarkdownViewer content={row.result} />
          : <pre>{row.result.split("\n").map((line, i) => <div className="ln" key={i}><span aria-hidden="true" className="ln-n">{i + 1}</span><span className="ln-t">{line || "\u200b"}</span></div>)}</pre>}
      </div>
      <p className="attach-note">{t.receipts.resultNote}</p>
    </section>}

    {(thread.length > 1 || !!row.threadId) && <section className="thread" aria-labelledby="thread-title">
      <h2 id="thread-title" className="prompt-header-title">{t.receipts.thread(thread.length)}</h2>
      {row.threadId && !thread.some(item => item.id === row.threadId) && <p className="attach-note">{t.receipts.threadMissing}</p>}
      <ol className="thread-list">
        {thread.map(item => <li key={item.id}>
          <button type="button" className="thread-item" aria-current={item.id === row.id ? "true" : undefined}
            disabled={item.id === row.id} onClick={() => onOpen(item.id)}>
            <span className="row-head"><strong>{item.title}</strong><time className="tnum">{item.id === row.id ? t.receipts.threadCurrent : formatDay(item.createdAt, locale)}</time></span>
            <RouteMini row={item} devices={devices} />
          </button>
        </li>)}
      </ol>
    </section>}

    <footer className="detail-foot">
      <span className="tnum">{project ? <ProjectTag project={project} /> : t.noProject} · {textless ? t.images.count(images) : t.meta(lines.length, row.content.length)}{row.expiresAt ? ` · ${t.expires(formatDay(row.expiresAt, locale))}` : ""}</span>
      <span className="boundary"><Info size={14} aria-hidden="true" />{demo ? t.sampleBoundary : t.boundary}</span>
    </footer>
    {noteOpen && <CompleteWithNoteDialog title={row.title} busy={busy}
      onCancel={() => { setNoteOpen(false); requestAnimationFrame(() => moreButton.current?.focus()); }}
      onConfirm={result => { setNoteOpen(false); onStatus("done", result); }} />}
  </article>;
}
