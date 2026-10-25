import { afterEach, describe, expect, it, vi } from 'vitest';
import { shareLink, whatsappUrl } from './share';

describe('whatsappUrl', () => {
  it('carries the whole note, line breaks and emoji included', () => {
    const text = "Hi! I'm going to *Sunday 5s*\n📅 Sat, 7 Nov at 7:00 pm\nhttps://circls.app/events/e1";
    const url = whatsappUrl(text);
    // api.whatsapp.com, not wa.me: wa.me's redirect mangles emoji into "�".
    expect(url.startsWith('https://api.whatsapp.com/send?text=')).toBe(true);
    expect(url).toContain('%F0%9F%93%85'); // 📅, as UTF-8
    expect(decodeURIComponent(url.slice('https://api.whatsapp.com/send?text='.length))).toBe(text);
  });
});

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

  it('copies the given text instead of the bare link when asked to', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const copy = `Care to join me?\n${data.url}`;
    await expect(shareLink(data, { copy })).resolves.toBe('copied');
    expect(writeText).toHaveBeenCalledWith(copy);
  });

  it('says so when neither sharing nor the clipboard is available', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    await expect(shareLink(data)).resolves.toBe('unavailable');
    vi.stubGlobal('navigator', {});
    await expect(shareLink(data)).resolves.toBe('unavailable');
  });
});
