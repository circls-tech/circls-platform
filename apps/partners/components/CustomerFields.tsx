'use client';

import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import {
  CUSTOMER_SEARCH_MIN_QUERY,
  type CustomerSuggestion,
  useCustomerSuggestions,
} from '@/lib/api/customers';
import { describeCustomer, lastSeenLabel } from '@/lib/customers/describe';
import { useTimezone } from '@/lib/timezone_context';
import { Input } from '@/lib/ui';

export interface CustomerFieldsProps {
  tenantId: string;
  name: string;
  contact: string;
  onChange: (next: { name: string; contact: string }) => void;
  nameLabel?: string;
  namePlaceholder?: string;
  nameRequired?: boolean;
  /** Focus the name field when the form appears. */
  autoFocusName?: boolean;
  contactLabel?: string;
  contactPlaceholder?: string;
  contactRequired?: boolean;
  contactHint?: string;
}

type Field = 'name' | 'contact';

/**
 * The customer's name and contact on the desk forms (reception booking, Add
 * registration, Add member), with autofill from the org's own history: start
 * typing a name or a phone number in either field and the people recorded
 * before who match are offered underneath. Picking one fills both fields.
 *
 * Only a convenience. Both fields stay plain inputs — a new customer is typed
 * in as before — and a pick merely fills them, so what gets recorded is
 * exactly what the form shows, whether it was typed or chosen.
 */
export function CustomerFields({
  tenantId,
  name,
  contact,
  onChange,
  nameLabel = 'Name',
  namePlaceholder,
  nameRequired = true,
  autoFocusName = false,
  contactLabel = 'Contact (optional)',
  contactPlaceholder = 'Phone or email',
  contactRequired = false,
  contactHint,
}: CustomerFieldsProps) {
  // The field being typed in decides which value drives the search and
  // under which input the list appears.
  const [active, setActive] = useState<Field | null>(null);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  // Set by a pick, cleared by the next edit: tells the user where the
  // details came from.
  const [filledFrom, setFilledFrom] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const { resolveTz } = useTimezone();

  const query = active === 'name' ? name : active === 'contact' ? contact : '';
  const { suggestions, isLoading } = useCustomerSuggestions(tenantId, query);
  const searching = query.trim().length >= CUSTOMER_SEARCH_MIN_QUERY;
  const showList = open && active !== null && searching && (isLoading || suggestions.length > 0);

  // A new answer starts from its first row.
  useEffect(() => {
    setHighlighted(0);
  }, [suggestions]);

  // Close on a click anywhere else (the inputs' own blur handles keyboard
  // focus leaving; a click on a suggestion must not count as leaving).
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  function edit(field: Field, value: string) {
    setFilledFrom(null);
    setActive(field);
    setOpen(true);
    onChange(field === 'name' ? { name: value, contact } : { name, contact: value });
  }

  function pick(s: CustomerSuggestion) {
    // A customer whose contact was never recorded keeps whatever is typed.
    onChange({ name: s.name, contact: s.contact ?? contact });
    setFilledFrom(s.name);
    setOpen(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!showList) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted((h) => Math.min(h + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      // Choosing from the list must not also submit the form around it.
      const s = suggestions[highlighted];
      if (s) {
        e.preventDefault();
        pick(s);
      }
    } else if (e.key === 'Escape') {
      // Only the list closes; the dialog around it stays (the Modal listens
      // on the document, so stop it hearing this one).
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  }

  function onBlur(e: React.FocusEvent<HTMLDivElement>) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
  }

  const list = showList && (
    <ul
      id={listId}
      role="listbox"
      aria-label="Customers you've recorded before"
      className="absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-[var(--radius)] border border-[#e5e7eb] bg-white py-1 shadow-lg"
    >
      {suggestions.length === 0 ? (
        <li className="px-3 py-2 text-sm text-slate-400">Searching…</li>
      ) : (
        suggestions.map((s, i) => (
          <li
            key={`${s.name}|${s.contact ?? ''}`}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === highlighted}
          >
            <button
              type="button"
              // mousedown, not click: the input blurs on mousedown, and a
              // blur that closed the list would swallow the click.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(s)}
              onMouseEnter={() => setHighlighted(i)}
              className={[
                'flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left',
                i === highlighted ? 'bg-slate-50' : '',
              ].join(' ')}
            >
              <span className="flex w-full items-baseline justify-between gap-3">
                <span className="truncate text-sm font-medium text-slate-800">{s.name}</span>
                <span className="shrink-0 text-xs text-slate-400">
                  {lastSeenLabel(s.lastSeenAt, resolveTz())}
                </span>
              </span>
              <span className="flex w-full items-baseline justify-between gap-3 text-xs text-slate-500">
                <span className="truncate">{s.contact ?? 'No contact recorded'}</span>
                <span className="shrink-0 text-slate-400">{describeCustomer(s)}</span>
              </span>
            </button>
          </li>
        ))
      )}
    </ul>
  );

  const comboProps = (field: Field) => ({
    role: 'combobox' as const,
    'aria-autocomplete': 'list' as const,
    'aria-expanded': showList && active === field,
    'aria-controls': showList && active === field ? listId : undefined,
    'aria-activedescendant':
      showList && active === field && suggestions[highlighted] ? `${listId}-${highlighted}` : undefined,
    autoComplete: 'off',
    onFocus: () => {
      setActive(field);
      setOpen(true);
    },
    onKeyDown,
  });

  return (
    <div ref={boxRef} onBlur={onBlur} className="flex flex-col gap-4">
      <div className="relative">
        <Input
          label={nameLabel}
          value={name}
          onChange={(e) => edit('name', e.target.value)}
          required={nameRequired}
          autoFocus={autoFocusName}
          {...(namePlaceholder !== undefined ? { placeholder: namePlaceholder } : {})}
          {...comboProps('name')}
        />
        {active === 'name' && list}
      </div>
      <div className="relative">
        <Input
          label={contactLabel}
          value={contact}
          onChange={(e) => edit('contact', e.target.value)}
          required={contactRequired}
          placeholder={contactPlaceholder}
          {...(filledFrom
            ? { hint: `Filled in from ${filledFrom}'s earlier visit — edit anything that's changed.` }
            : contactHint !== undefined
              ? { hint: contactHint }
              : {})}
          {...comboProps('contact')}
        />
        {active === 'contact' && list}
      </div>
    </div>
  );
}
