import type { Child } from 'hono/jsx';
import { Icon } from '../icons';

export type EvidenceFile = {
  /** Inline URL: the viewer shows it, and without JavaScript the browser opens it. */
  viewUrl: string;
  /** Omitted where the file has no download route (staged imports). */
  downloadUrl?: string;
  mime: string;
  filename: string;
};

/** A link that opens the file in the evidence viewer. Links sharing a group
 *  can be paged through with Previous and Next. */
export function EvidenceLink({
  file,
  group,
  hidden,
  duplicate,
  class: className,
  children,
}: {
  file: EvidenceFile;
  group: string;
  hidden?: boolean;
  /** A second link to a file already linked by name, such as a thumbnail:
   *  kept out of the tab order and away from screen readers. */
  duplicate?: boolean;
  class?: string;
  children?: Child;
}) {
  return (
    <a
      href={file.viewUrl}
      class={className}
      hidden={hidden}
      tabindex={duplicate ? -1 : undefined}
      aria-hidden={duplicate ? 'true' : undefined}
      data-evidence-view
      data-evidence-group={group}
      data-evidence-mime={file.mime}
      data-evidence-name={file.filename}
      data-evidence-download={file.downloadUrl}
    >
      {children ?? file.filename}
    </a>
  );
}

/** The modal viewer, filled by /evidence-viewer.js. Render once per page. */
export function EvidenceViewer() {
  return (
    <>
      <dialog class="evidence-viewer" id="evidence-viewer" aria-labelledby="evidence-viewer-title">
        <div class="evidence-viewer-bar">
          <div class="evidence-viewer-heading">
            <strong id="evidence-viewer-title"></strong>
            <span class="muted" data-viewer-count></span>
          </div>
          <div class="evidence-viewer-actions">
            <button type="button" class="btn btn-secondary btn-sm" data-viewer-prev>Previous</button>
            <button type="button" class="btn btn-secondary btn-sm" data-viewer-next>Next</button>
            <a class="btn btn-secondary btn-sm" data-viewer-open target="_blank" rel="noopener">
              <Icon name="external-link" />
              Open
            </a>
            <a class="btn btn-secondary btn-sm" data-viewer-download>
              <Icon name="download" />
              Download
            </a>
            <button type="button" class="btn btn-primary btn-sm" data-viewer-close>Close</button>
          </div>
        </div>
        <div class="evidence-viewer-stage" data-viewer-stage></div>
      </dialog>
      <script src="/evidence-viewer.js" defer></script>
    </>
  );
}

export function expenseEvidenceFile(expenseId: number, attachment: { id: number; mime: string; filename: string }): EvidenceFile {
  const base = `/admin/expenses/${expenseId}/attachments/${attachment.id}`;
  return { viewUrl: `${base}/view`, downloadUrl: base, mime: attachment.mime, filename: attachment.filename };
}
