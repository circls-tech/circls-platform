import { afterEach, describe, expect, it, vi } from 'vitest';
import { shareLink } from './share';

const data = { title: 'Sunday 5s', url: 'https://circls.app/events/evt_1' };

afterEach(() => vi.unstubAllGlobals());

describe('shareLink', () => {
  it('uses the native share sheet when the browser offers one', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn();
    vi.stubGlobal('navigator', { share, canShare: () => true, clipboard: { writeText } });
    await expect(shareLink(data)).resolves.toBe('shared');
    expect(share).toHaveBeenCalledWith(data);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('reports a dismissed sheet without falling back to the clipboard', async () => {
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const writeText = vi.fn();
    vi.stubGlobal('navigator', { share: vi.fn().mockRejectedValue(abort), clipboard: { writeText } });
    await expect(shareLink(data)).resolves.toBe('dismissed');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('copies the link when share() fails for any other reason', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { share: vi.fn().mockRejectedValue(new Error('boom')), clipboard: { writeText } });
    await expect(shareLink(data)).resolves.toBe('copied');
    expect(writeText).toHaveBeenCalledWith(data.url);
  });

  it('copies the link when the browser cannot share this payload', async () => {
    const share = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { share, canShare: () => false, clipboard: { writeText } });
    await expect(shareLink(data)).resolves.toBe('copied');
    expect(share).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith(data.url);
  });

  it('copies the link on browsers with no share sheet at all', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await expect(shareLink(data)).resolves.toBe('copied');
    expect(writeText).toHaveBeenCalledWith(data.url);
  });

  it('says so when neither sharing nor the clipboard is available', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    await expect(shareLink(data)).resolves.toBe('unavailable');
    vi.stubGlobal('navigator', {});
    await expect(shareLink(data)).resolves.toBe('unavailable');
  });
});
