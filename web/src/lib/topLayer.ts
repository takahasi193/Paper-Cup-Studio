// トップレイヤー要素（<dialog>）の退場アニメーション補助。
// display / overlay の離散遷移に対応するブラウザ（Chromium）では CSS のみで退場が動く。
// 非対応ブラウザ（Firefox / Safari）では data-closing で視覚的な退場を先に走らせ、
// アニメーション完了後に close() する。

let supportsDisplayTransition: boolean | undefined;

function canTransitionDisplay(): boolean {
  if (supportsDisplayTransition !== undefined) return supportsDisplayTransition;
  if (!window.CSS?.supports?.('transition-behavior', 'allow-discrete') || !document.body) {
    return false;
  }
  const probe = document.createElement('div');
  probe.style.cssText = 'transition: display 1s allow-discrete !important; display: block;';
  document.body.appendChild(probe);
  getComputedStyle(probe).display;
  probe.style.display = 'none';
  supportsDisplayTransition = getComputedStyle(probe).display === 'block';
  probe.remove();
  return supportsDisplayTransition;
}

function supportsTopLayerExit(): boolean {
  return Boolean(window.CSS?.supports?.('overlay', 'auto')) && canTransitionDisplay();
}

export async function closeDialogAnimated(dialog: HTMLDialogElement): Promise<void> {
  if (!dialog.open) return;
  if (!supportsTopLayerExit()) {
    dialog.setAttribute('data-closing', '');
    const animations = dialog.getAnimations({ subtree: true });
    if (animations.length > 0) {
      await Promise.race([
        Promise.allSettled(animations.map((a) => a.finished)),
        new Promise((r) => setTimeout(r, 1000)),
      ]);
    }
    // 退場中に再オープンされた場合は close しない
    if (!dialog.hasAttribute('data-closing')) return;
    dialog.removeAttribute('data-closing');
  }
  dialog.close();
}

export function openDialog(dialog: HTMLDialogElement): void {
  dialog.removeAttribute('data-closing');
  if (!dialog.open) dialog.showModal();
}
