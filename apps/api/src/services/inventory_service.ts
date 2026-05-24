import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type Booking, bookings } from '../db/schema/index.js';

export async function getBookingById(bookingId: string): Promise<Booking | undefined> {
  return db.query.bookings.findFirst({ where: eq(bookings.id, bookingId) });
}
