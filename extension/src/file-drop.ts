import { MAX_UPLOAD_BYTES } from '../../shared/protocol';

export interface FileDropOptions {
  /** Sends a file to the terminal's session as base64; false when it is not connected. */
  send(name: string, base64: string): boolean;
  /** Shows or, with null, clears a message about a file that could not be added. */
  notice(text: string | null): void;
}

const hasFiles = (event: DragEvent): boolean => [...(event.dataTransfer?.types ?? [])].includes('Files');

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Lets files be dropped or pasted onto the terminal. A browser never exposes where a dropped file
 * lives, so each is sent to the helper, which saves it and answers with a path to type into the shell,
 * as a terminal does with a dragged file.
 */
export function attachFileDrop(target: HTMLElement, { send, notice }: FileDropOptions): void {
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  const warn = (text: string): void => {
    notice(text);
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => notice(null), 5000);
  };

  async function add(files: readonly File[]): Promise<void> {
    for (const file of files) {
      if (file.size > MAX_UPLOAD_BYTES) {
        warn(`${file.name} is over ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB, so it was not added.`);
        continue;
      }
      try {
        if (!send(file.name || 'file', await readBase64(file))) warn('Not connected to the terminal, so the file was not added.');
      } catch {
        warn(`Could not read ${file.name}.`);
      }
    }
  }

  // Without a drop target Chrome would open the file in the panel instead.
  target.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    target.classList.add('drop-target');
  });
  target.addEventListener('dragleave', (event) => {
    if (!target.contains(event.relatedTarget as Node | null)) target.classList.remove('drop-target');
  });
  target.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    target.classList.remove('drop-target');
    void add([...(event.dataTransfer?.files ?? [])]);
  });

  // A screenshot on the clipboard arrives as a file; plain text is left for the terminal's own paste.
  target.addEventListener(
    'paste',
    (event) => {
      const files = [...(event.clipboardData?.files ?? [])];
      if (files.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      void add(files);
    },
    true,
  );
}
