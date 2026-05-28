'use client';
import { useId, useRef, useState } from 'react';
import { Badge } from './Badge';

export interface TagsInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  label?: string;
}

/**
 * Controlled chip-based tags input.
 * - Commit a tag on Enter or comma
 * - Backspace on empty input removes the last chip
 * - Chips show as Badge with an × remove button
 */
export function TagsInput({ value, onChange, placeholder = 'Add tag…', label }: TagsInputProps) {
  const [inputVal, setInputVal] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();

  function commitPending(raw: string) {
    const trimmed = raw.trim().replace(/,$/, '').trim();
    if (!trimmed) return;
    // De-duplicate
    if (!value.includes(trimmed)) {
      onChange([...value, trimmed]);
    }
    setInputVal('');
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitPending(inputVal);
    } else if (e.key === 'Backspace' && inputVal === '' && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    // Commit on comma immediately
    if (v.endsWith(',')) {
      commitPending(v);
    } else {
      setInputVal(v);
    }
  }

  function removeTag(tag: string) {
    onChange(value.filter((t) => t !== tag));
  }

  return (
    <div className="flex flex-col gap-1">
      {label != null && (
        <label
          htmlFor={id}
          className="text-xs font-medium uppercase tracking-wide text-[#475569]"
        >
          {label}
        </label>
      )}
      <div
        className="flex min-h-[38px] flex-wrap items-center gap-1.5 rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-2 py-1.5 transition-colors hover:border-slate-300 focus-within:border-brand-500 focus-within:ring-1 focus-within:ring-brand-500/20 cursor-text"
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((tag) => (
          <span key={tag} className="inline-flex items-center gap-1">
            <Badge tone="neutral" label={tag} />
            <button
              type="button"
              aria-label={`Remove tag ${tag}`}
              onClick={(e) => { e.stopPropagation(); removeTag(tag); }}
              className="ml-0.5 rounded-full text-slate-400 hover:text-slate-700 focus:outline-none focus:ring-1 focus:ring-brand-400"
            >
              <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" d="M2 2l8 8M10 2l-8 8" />
              </svg>
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={id}
          type="text"
          value={inputVal}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onBlur={() => commitPending(inputVal)}
          placeholder={value.length === 0 ? placeholder : ''}
          className="min-w-[80px] flex-1 bg-transparent text-sm text-[#0f172a] placeholder:text-[#94a3b8] outline-none"
          aria-label={label ?? 'Tags'}
        />
      </div>
      <p className="text-xs text-[#94a3b8]">Press Enter or comma to add a tag</p>
    </div>
  );
}
