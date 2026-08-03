import {disableAllInput, enableAllInput} from "./utils";

let currentProgressAbortCallback = null;
let currentProgressEnoughCallback = null;

export function initProgress(options = {}) {
    const { title = "Loading...", filename = "", showAbort = false, onAbort = null,
        showEnough = false, onEnough = null, enoughLabel = "Enough" } = options;
    
    disableAllInput(title);
    
    const overlay = document.getElementById('input-blocker');
    const filenameDiv = document.getElementById('input-blocker-filename');
    const progressContainer = document.getElementById('input-blocker-progress-container');
    const progressBar = document.getElementById('input-blocker-progress-bar');
    const progressText = document.getElementById('input-blocker-progress-text');
    
    if (filenameDiv && progressContainer && progressBar && progressText) {
        filenameDiv.textContent = filename;
        filenameDiv.style.display = filename ? 'block' : 'none';
        progressContainer.style.display = 'flex';
        progressBar.style.width = '0%';
        progressText.textContent = 'Waiting for server...';
    }
    
    // "Enough" stops the work early but KEEPS what it has, so the caller finishes with a
    // shorter dataset rather than nothing. Sits above Abort, and is green rather than red,
    // because it is a normal way to finish - not a way to give up. Callers that have no
    // usable partial result simply don't pass onEnough, and only Abort is offered.
    let enoughButton = document.getElementById('input-blocker-enough-button');
    if (showEnough && onEnough) {
        currentProgressEnoughCallback = onEnough;
        if (!enoughButton && overlay) {
            enoughButton = document.createElement('button');
            enoughButton.id = 'input-blocker-enough-button';
            enoughButton.style.marginTop = '20px';
            enoughButton.style.padding = '10px 30px';
            enoughButton.style.fontSize = '18px';
            enoughButton.style.cursor = 'pointer';
            enoughButton.style.backgroundColor = '#4caf50';
            enoughButton.style.color = 'white';
            enoughButton.style.border = 'none';
            enoughButton.style.borderRadius = '5px';
            enoughButton.onclick = (e) => {
                e.stopPropagation();
                if (currentProgressEnoughCallback) {
                    currentProgressEnoughCallback();
                }
            };
            // Above Abort, whichever order the two get created in. The abort button
            // outlives a run (it is only removed when a later caller asks for no abort),
            // so a plain append would land below it on any run after the first.
            const existingAbort = document.getElementById('input-blocker-abort-button');
            if (existingAbort) {
                overlay.insertBefore(enoughButton, existingAbort);
            } else {
                overlay.appendChild(enoughButton);
            }
        }
        // Set every time, not just on creation: the button is reused across runs, and a
        // later caller's label must not be left showing the previous caller's wording.
        enoughButton.textContent = enoughLabel;
    } else if (enoughButton) {
        enoughButton.remove();
        currentProgressEnoughCallback = null;
    }

    let abortButton = document.getElementById('input-blocker-abort-button');
    if (showAbort && onAbort) {
        currentProgressAbortCallback = onAbort;
        if (!abortButton && overlay) {
            abortButton = document.createElement('button');
            abortButton.id = 'input-blocker-abort-button';
            abortButton.textContent = 'Abort';
            abortButton.style.marginTop = '20px';
            abortButton.style.padding = '10px 30px';
            abortButton.style.fontSize = '18px';
            abortButton.style.cursor = 'pointer';
            abortButton.style.backgroundColor = '#f44336';
            abortButton.style.color = 'white';
            abortButton.style.border = 'none';
            abortButton.style.borderRadius = '5px';
            abortButton.onclick = (e) => {
                e.stopPropagation();
                if (currentProgressAbortCallback) {
                    currentProgressAbortCallback();
                }
            };
            overlay.appendChild(abortButton);
        }
    } else if (abortButton) {
        abortButton.remove();
        currentProgressAbortCallback = null;
    }
}

export function updateProgress(options = {}) {
    const { status, loaded, total, filename, retryInfo, percent } = options;

    const filenameDiv = document.getElementById('input-blocker-filename');
    const progressBar = document.getElementById('input-blocker-progress-bar');
    const progressText = document.getElementById('input-blocker-progress-text');

    if (filename && filenameDiv) {
        filenameDiv.textContent = filename;
        filenameDiv.style.display = 'block';
    }

    if (progressBar && progressText) {
        let text = status || '';

        if (retryInfo) {
            text = `Retry ${retryInfo.attempt}/${retryInfo.maxRetries}: Going back ${retryInfo.daysBack} days...`;
        }

        if (percent !== undefined) {
            // Direct percentage control with custom status text
            progressBar.style.width = Math.min(100, Math.max(0, percent)) + '%';
        } else if (loaded !== undefined && total !== undefined && total > 0) {
            const percentage = (loaded / total * 100).toFixed(1);
            progressBar.style.width = percentage + '%';
            const loadedKB = (loaded / 1024).toFixed(0);
            const totalKB = (total / 1024).toFixed(0);
            text = `${loadedKB} KB / ${totalKB} KB (${percentage}%)`;
        } else if (status) {
            progressBar.style.width = '0%';
        }

        progressText.textContent = text;
    }
}

export function hideProgress() {
    currentProgressAbortCallback = null;
    currentProgressEnoughCallback = null;
    enableAllInput();
}
