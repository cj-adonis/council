// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { ConfirmTabAction } from '../components/ConfirmTabAction';

test('delete requires confirmation and disables repeated submissions while pending', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const prototype = HTMLDialogElement.prototype;
  const originalShow = Object.getOwnPropertyDescriptor(prototype, 'showModal');
  const originalClose = Object.getOwnPropertyDescriptor(prototype, 'close');
  // jsdom does not implement the native dialog lifecycle.
  const showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
  Object.defineProperty(prototype, 'showModal', { configurable: true, value: showModal });
  Object.defineProperty(prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let finish!: () => void;
  const confirm = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const cancel = vi.fn();
  try {
    await act(async () => root.render(createElement(ConfirmTabAction, {
      title: 'Saved task', action: 'delete', running: false, onCancel: cancel, onConfirm: confirm,
    })));
    expect(showModal).toHaveBeenCalledOnce();
    expect(host.textContent).toContain('Saved task');
    expect(confirm).not.toHaveBeenCalled();
    const [cancelButton, deleteButton] = host.querySelectorAll('button');
    await act(async () => cancelButton!.click());
    expect(cancel).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
    await act(async () => deleteButton!.click());
    expect(deleteButton!.disabled).toBe(true);
    await act(async () => deleteButton!.click());
    expect(confirm).toHaveBeenCalledOnce();
    await act(async () => { finish(); });
    expect(deleteButton!.disabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    if (originalShow) Object.defineProperty(prototype, 'showModal', originalShow);
    else Reflect.deleteProperty(prototype, 'showModal');
    if (originalClose) Object.defineProperty(prototype, 'close', originalClose);
    else Reflect.deleteProperty(prototype, 'close');
  }
});
