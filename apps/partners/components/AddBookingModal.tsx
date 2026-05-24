'use client';

import { type FormEvent, useEffect, useRef, useState } from 'react';
import type { Slot } from '@/lib/api/types';
import { useBookSlots, useHoldSlots, useReleaseHoldSlots } from '@/lib/api/queries';
import { ApiError } from '@/lib/api/client';
import { Button, Input, Modal } from '@/lib/ui';

export interface AddBookingModalProps {
  arenaId: string;
  open: boolean;
  slotIds: string[];
  slots: Slot[];
  onClose: () => void;
}

export function AddBookingModal({
  arenaId,
  open,
  slotIds,
  slots,
  onClose,
}: AddBookingModalProps) {
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const holdSlots = useHoldSlots(arenaId);
  const releaseHold = useReleaseHoldSlots(arenaId);
  const bookSlots = useBookSlots(arenaId);

  // Track whether we have placed a hold for this open session
  const heldRef = useRef(false);

  // On open, place hold. Reset form state.
  useEffect(() => {
    if (open && slotIds.length > 0) {
      setName('');
      setContact('');
      setNote('');
      setError(null);
      heldRef.current = true;
      holdSlots.mutate(slotIds);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Release hold if the modal unmounts while a hold is active and no booking
  // was confirmed (guard: heldRef is set to false on successful booking).
  useEffect(() => {
    return () => {
      if (heldRef.current && slotIds.length > 0) {
        releaseHold.mutate(slotIds);
        heldRef.current = false;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Compute total from the selected slots regardless of status.
  // We intentionally do NOT filter by status === 'open' because on open the
  // modal places a hold, which refetches slots as status:'held', collapsing the
  // total to ₹0. Selection membership is the only predicate needed here.
  const totalPaise = slots
    .filter((s) => slotIds.includes(s.id))
    .reduce((sum, s) => sum + s.pricePaise, 0);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await bookSlots.mutateAsync({
        slotIds,
        customer: { name: name.trim(), contact: contact.trim(), note: note.trim() || undefined },
      });
      heldRef.current = false;
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'slot_taken') {
        setError('Some slots were just taken — close and refresh.');
      } else {
        setError((err as Error).message);
      }
    }
  }

  function handleClose() {
    // Release hold if we had placed one and no booking was made
    if (heldRef.current && slotIds.length > 0) {
      releaseHold.mutate(slotIds);
      heldRef.current = false;
    }
    onClose();
  }

  return (
    <Modal open={open} onClose={handleClose} title="Add booking" maxWidth="max-w-md">
      <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
        {/* Total */}
        <div className="rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-700">
          <span className="font-medium">Total: </span>
          <span className="text-base font-semibold text-slate-900">
            ₹{(totalPaise / 100).toFixed(0)}
          </span>
          <span className="ml-2 text-xs text-slate-400">
            ({slotIds.length} slot{slotIds.length !== 1 ? 's' : ''})
          </span>
        </div>

        <Input
          label="Customer name"
          placeholder="e.g. Ravi Kumar"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          autoFocus
        />

        <Input
          label="Contact (phone / email)"
          placeholder="e.g. 9876543210"
          value={contact}
          onChange={(e) => setContact(e.target.value)}
          required
        />

        <Input
          label="Note (optional)"
          placeholder="e.g. Birthday party"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />

        {error && (
          <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        )}

        <div className="flex justify-end gap-3 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={bookSlots.isPending}
            disabled={bookSlots.isPending || !name.trim() || !contact.trim()}
          >
            Confirm booking
          </Button>
        </div>
      </form>
    </Modal>
  );
}
