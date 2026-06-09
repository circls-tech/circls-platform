# Coupon Codes — Flutter Consumer Checkout Implementation Plan (Plan 4 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring transparent checkout + discount coupons to the **Flutter consumer app** (separate repo `/Users/vedant/personal/circls`): every Book/Register/Buy shows a breakdown (base price, applied discount, "Other charges (incl taxes)" gross-up, total), lets the user apply a coupon (typed, or picked from public offers for events/memberships), then pays via Razorpay — matching the web consumer experience (Plan 3), which is already live in production.

**Architecture:** A shared `CheckoutQuote` + `PublicCoupon` Freezed model pair, a `CheckoutApiRepository` calling the live Plan 1 endpoints, two reusable widgets (`CheckoutBreakdown`, `CouponPicker`), and one shared `confirmAndPay()` helper. Slots reuse the existing `ReviewScreen` (enhanced with the breakdown + coupon inline); events/memberships open a new `CheckoutSheet` bottom sheet. `couponCode` is threaded into the three existing booking repository methods. The quote endpoint is the single source of displayed pricing; the backend re-validates on booking.

**Tech Stack:** Flutter/Dart, Riverpod (manual providers), Dio (+ Firebase-token `AuthInterceptor`), Freezed + json_serializable (build_runner codegen), Go Router, mocktail tests.

Backend contract is LIVE (`release-2026-06-08.4`). Web equivalent: Plan 3 (`docs/superpowers/plans/2026-06-08-coupons-web-consumer-modal.md`). Context: memory `coupons-checkout-status.md`.

> **NOTE:** This plan's code lives in the **`/Users/vedant/personal/circls` Flutter repo**, NOT in circls-platform. It is its own branch/commits. (The plan doc is stored in the circls-platform `docs/superpowers/plans/` folder by request.)

---

## The backend contract this binds to (live in prod)

**Quote** — `POST /v1/consumer/checkout/quote` (Firebase-authed). Body is one of:
```jsonc
{ "itemType": "slot",       "slotIds": ["..."],   "couponCode": "SUMMER10" }  // couponCode optional
{ "itemType": "event",      "eventId": "...",      "couponCode": "..." }
{ "itemType": "membership", "membershipId": "...", "couponCode": "..." }
```
Returns:
```jsonc
{
  "basePaise": 50000,
  "discountPaise": 5000,
  "discountedBasePaise": 45000,
  "otherChargesPaise": 1088,   // the "Other charges (incl taxes)" line
  "totalPaise": 46088,         // what the customer pays; 0 ⇒ free
  "coupon": { "id": "...", "code": "SUMMER10", "description": null },  // or null
  "error": "coupon_not_found"  // present only when a typed coupon was rejected; base pricing still returned
}
```

**Public offers** — `GET /v1/consumer/coupons?itemType=event|membership&itemId=<id>` (public). Returns
`{ "rows": [{ "code", "description", "discountType": "percent"|"fixed", "discountValue", "maxDiscountPaise", "minOrderPaise" }] }`.
**Slots are not supported here** — slot checkouts use manual code entry only (the quote endpoint still validates a typed code for slots).

**Booking** — the three existing routes now accept an optional `couponCode` in the body:
`POST /v1/consumer/bookings` (slots), `POST /v1/consumer/events/:id/book`, `POST /v1/consumer/memberships/:id/purchase`. Response shapes unchanged (`SlotBookingResult` / `EventBookingResult` / `MembershipPurchaseResult`).

**Free vs reserved:** use the quote's `totalPaise`. `0` ⇒ free/confirmed; `> 0` with a Razorpay order ⇒ pay; `> 0` with no order (empty keyId/orderId) ⇒ reserved (payments-not-enabled stub). `RazorpayCheckout().open()` already returns `CheckoutKind.reserved` for empty keyId/orderId.

`discountValue` units: **basis points** when `discountType == 'percent'` (1000 = 10%), **paise** when `fixed`.

---

## File Structure (in `/Users/vedant/personal/circls`)

**Create:**
- `lib/src/domain/booking/checkout_quote.dart` — `CheckoutQuote` + `QuoteCoupon` Freezed models.
- `lib/src/domain/booking/public_coupon.dart` — `PublicCoupon` Freezed model.
- `lib/src/domain/booking/checkout_item.dart` — `CheckoutItem` sealed class (slot/event/membership descriptor).
- `lib/src/data/checkout/checkout_api_repository.dart` — `getQuote()` + `getPublicCoupons()`.
- `lib/src/data/checkout/checkout_providers.dart` — `checkoutRepositoryProvider`.
- `lib/src/presentation/checkout/checkout_breakdown.dart` — breakdown widget.
- `lib/src/presentation/checkout/coupon_picker.dart` — dropdown + text coupon widget.
- `lib/src/presentation/checkout/checkout_actions.dart` — shared `confirmAndPay()` helper.
- `lib/src/presentation/checkout/checkout_sheet.dart` — bottom sheet for events/memberships.
- `test/data/checkout/checkout_api_repository_test.dart` — repo tests.

**Modify:**
- `lib/src/data/booking/booking_api_repository.dart` + the `BookingRepository` interface — add `couponCode` to `bookSlots`/`bookEvent`/`purchaseMembership`.
- `lib/src/presentation/booking/review_screen.dart` — show breakdown + coupon, pay via the shared helper.
- `lib/src/presentation/events/event_detail_screen.dart` — Book opens `CheckoutSheet`.
- `lib/src/presentation/memberships/membership_detail_screen.dart` — Buy opens `CheckoutSheet`.
- `test/data/booking/booking_api_repository_test.dart` — assert `couponCode` in body.

---

## Task 1: Models — `CheckoutQuote`, `QuoteCoupon`, `PublicCoupon`

**Files:** Create `lib/src/domain/booking/checkout_quote.dart`, `lib/src/domain/booking/public_coupon.dart`.

- [ ] **Step 1: `checkout_quote.dart`** (mirror `slot_booking_result.dart`'s Freezed pattern)

```dart
import 'package:freezed_annotation/freezed_annotation.dart';

part 'checkout_quote.freezed.dart';
part 'checkout_quote.g.dart';

@freezed
class QuoteCoupon with _$QuoteCoupon {
  const factory QuoteCoupon({
    required String id,
    required String code,
    String? description,
  }) = _QuoteCoupon;
  factory QuoteCoupon.fromJson(Map<String, dynamic> json) => _$QuoteCouponFromJson(json);
}

/// Pricing breakdown from POST /v1/consumer/checkout/quote.
@freezed
class CheckoutQuote with _$CheckoutQuote {
  const factory CheckoutQuote({
    required int basePaise,
    required int discountPaise,
    required int discountedBasePaise,
    required int otherChargesPaise,
    required int totalPaise,
    QuoteCoupon? coupon,
    /// Set when a typed coupon was rejected (base pricing is still returned).
    String? error,
  }) = _CheckoutQuote;
  factory CheckoutQuote.fromJson(Map<String, dynamic> json) => _$CheckoutQuoteFromJson(json);
}
```

- [ ] **Step 2: `public_coupon.dart`**

```dart
import 'package:freezed_annotation/freezed_annotation.dart';

part 'public_coupon.freezed.dart';
part 'public_coupon.g.dart';

/// A publicly-listable offer from GET /v1/consumer/coupons (events/memberships).
@freezed
class PublicCoupon with _$PublicCoupon {
  const PublicCoupon._();
  const factory PublicCoupon({
    required String code,
    String? description,
    required String discountType, // 'percent' | 'fixed'
    required int discountValue,   // basis points (percent) or paise (fixed)
    int? maxDiscountPaise,
    int? minOrderPaise,
  }) = _PublicCoupon;
  factory PublicCoupon.fromJson(Map<String, dynamic> json) => _$PublicCouponFromJson(json);

  /// Short label for the dropdown, e.g. "10% off" or "₹50 off".
  String get offerLabel =>
      discountType == 'percent' ? '${discountValue / 100}% off' : '₹${(discountValue / 100).toStringAsFixed(0)} off';
}
```

- [ ] **Step 3: Generate code**

Run: `cd /Users/vedant/personal/circls && dart run build_runner build --delete-conflicting-outputs`
Expected: generates `checkout_quote.freezed.dart` / `.g.dart` and `public_coupon.freezed.dart` / `.g.dart`, no errors.

- [ ] **Step 4: Analyze + commit**

Run: `cd /Users/vedant/personal/circls && dart analyze lib/src/domain/booking` → no issues.
```bash
git add lib/src/domain/booking/checkout_quote.dart lib/src/domain/booking/checkout_quote.freezed.dart lib/src/domain/booking/checkout_quote.g.dart lib/src/domain/booking/public_coupon.dart lib/src/domain/booking/public_coupon.freezed.dart lib/src/domain/booking/public_coupon.g.dart
git commit -m "feat: checkout quote + public coupon models"
```

---

## Task 2: `CheckoutItem` descriptor

**Files:** Create `lib/src/domain/booking/checkout_item.dart`.

- [ ] **Step 1: Sealed class**

```dart
/// What the user is buying — drives the quote request, the booking call, and the
/// checkout title. Dart 3 sealed class so `switch` is exhaustive.
sealed class CheckoutItem {
  const CheckoutItem();
  String get title;
}

final class SlotCheckout extends CheckoutItem {
  const SlotCheckout({required this.slotIds, required this.title, this.note});
  final List<String> slotIds;
  @override
  final String title;
  final String? note;
}

final class EventCheckout extends CheckoutItem {
  const EventCheckout({required this.eventId, required this.title});
  final String eventId;
  @override
  final String title;
}

final class MembershipCheckout extends CheckoutItem {
  const MembershipCheckout({required this.membershipId, required this.title});
  final String membershipId;
  @override
  final String title;
}
```

- [ ] **Step 2: Analyze + commit**

Run: `cd /Users/vedant/personal/circls && dart analyze lib/src/domain/booking/checkout_item.dart` → no issues.
```bash
git add lib/src/domain/booking/checkout_item.dart
git commit -m "feat: checkout item descriptor"
```

---

## Task 3: Checkout repository (quote + public coupons)

**Files:** Create `lib/src/data/checkout/checkout_api_repository.dart`, `lib/src/data/checkout/checkout_providers.dart`. Test: `test/data/checkout/checkout_api_repository_test.dart`.

- [ ] **Step 1: Write the failing test** (mirror `test/data/booking/booking_api_repository_test.dart`'s mocktail/`_MockDio` pattern — copy its `_MockDio` setup)

```dart
import 'package:circls/src/data/checkout/checkout_api_repository.dart';
import 'package:circls/src/domain/booking/checkout_item.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

class _MockDio extends Mock implements Dio {}

void main() {
  setUpAll(() => registerFallbackValue(RequestOptions(path: '/')));

  test('getQuote posts the item + coupon and parses the breakdown', () async {
    final dio = _MockDio();
    final repo = CheckoutApiRepository(dio);
    when(() => dio.post<Map<String, dynamic>>('/v1/consumer/checkout/quote', data: any(named: 'data')))
        .thenAnswer((_) async => Response<Map<String, dynamic>>(
              requestOptions: RequestOptions(path: '/'),
              data: {
                'basePaise': 50000, 'discountPaise': 5000, 'discountedBasePaise': 45000,
                'otherChargesPaise': 1088, 'totalPaise': 46088,
                'coupon': {'id': 'c1', 'code': 'SUMMER10', 'description': null},
              },
            ));
    final q = await repo.getQuote(const EventCheckout(eventId: 'e1', title: 'Gig'), couponCode: 'SUMMER10');
    expect(q.totalPaise, 46088);
    expect(q.coupon?.code, 'SUMMER10');
    final body = verify(() => dio.post<Map<String, dynamic>>('/v1/consumer/checkout/quote', data: captureAny(named: 'data')))
        .captured.single as Map<String, dynamic>;
    expect(body['itemType'], 'event');
    expect(body['eventId'], 'e1');
    expect(body['couponCode'], 'SUMMER10');
  });

  test('getQuote omits couponCode when null and maps slot ids', () async {
    final dio = _MockDio();
    final repo = CheckoutApiRepository(dio);
    when(() => dio.post<Map<String, dynamic>>('/v1/consumer/checkout/quote', data: any(named: 'data')))
        .thenAnswer((_) async => Response<Map<String, dynamic>>(
              requestOptions: RequestOptions(path: '/'),
              data: {'basePaise': 1000, 'discountPaise': 0, 'discountedBasePaise': 1000, 'otherChargesPaise': 25, 'totalPaise': 1025},
            ));
    await repo.getQuote(const SlotCheckout(slotIds: ['s1', 's2'], title: 'Court'));
    final body = verify(() => dio.post<Map<String, dynamic>>('/v1/consumer/checkout/quote', data: captureAny(named: 'data')))
        .captured.single as Map<String, dynamic>;
    expect(body['itemType'], 'slot');
    expect(body['slotIds'], ['s1', 's2']);
    expect(body.containsKey('couponCode'), isFalse);
  });

  test('getPublicCoupons parses rows', () async {
    final dio = _MockDio();
    final repo = CheckoutApiRepository(dio);
    when(() => dio.get<Map<String, dynamic>>('/v1/consumer/coupons', queryParameters: any(named: 'queryParameters')))
        .thenAnswer((_) async => Response<Map<String, dynamic>>(
              requestOptions: RequestOptions(path: '/'),
              data: {'rows': [{'code': 'SUMMER10', 'description': null, 'discountType': 'percent', 'discountValue': 1000, 'maxDiscountPaise': null, 'minOrderPaise': null}]},
            ));
    final rows = await repo.getPublicCoupons(itemType: 'event', itemId: 'e1');
    expect(rows.single.code, 'SUMMER10');
    expect(rows.single.offerLabel, '10% off');
  });
}
```

- [ ] **Step 2: Run it, confirm it FAILS** (no `CheckoutApiRepository`).

Run: `cd /Users/vedant/personal/circls && flutter test test/data/checkout/checkout_api_repository_test.dart`

- [ ] **Step 3: Implement the repository**

`lib/src/data/checkout/checkout_api_repository.dart`:
```dart
import 'package:dio/dio.dart';
import '../../domain/booking/checkout_item.dart';
import '../../domain/booking/checkout_quote.dart';
import '../../domain/booking/public_coupon.dart';

class CheckoutApiRepository {
  CheckoutApiRepository(this._dio);
  final Dio _dio;

  Future<CheckoutQuote> getQuote(CheckoutItem item, {String? couponCode}) async {
    final body = <String, dynamic>{
      ...switch (item) {
        SlotCheckout(:final slotIds) => {'itemType': 'slot', 'slotIds': slotIds},
        EventCheckout(:final eventId) => {'itemType': 'event', 'eventId': eventId},
        MembershipCheckout(:final membershipId) => {'itemType': 'membership', 'membershipId': membershipId},
      },
    };
    if (couponCode != null && couponCode.trim().isNotEmpty) body['couponCode'] = couponCode.trim();
    final res = await _dio.post<Map<String, dynamic>>('/v1/consumer/checkout/quote', data: body);
    return CheckoutQuote.fromJson(res.data!);
  }

  /// Public offers — only event/membership are supported server-side (not slots).
  Future<List<PublicCoupon>> getPublicCoupons({required String itemType, required String itemId}) async {
    final res = await _dio.get<Map<String, dynamic>>('/v1/consumer/coupons',
        queryParameters: {'itemType': itemType, 'itemId': itemId});
    final rows = (res.data!['rows'] as List).cast<Map<String, dynamic>>();
    return rows.map(PublicCoupon.fromJson).toList();
  }
}
```

`lib/src/data/checkout/checkout_providers.dart` (mirror `booking_providers.dart`):
```dart
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../api/api_providers.dart';
import 'checkout_api_repository.dart';

final checkoutRepositoryProvider = Provider<CheckoutApiRepository>((ref) {
  return CheckoutApiRepository(ref.watch(dioProvider));
});
```

- [ ] **Step 4: Run tests + analyze**

Run: `cd /Users/vedant/personal/circls && flutter test test/data/checkout/checkout_api_repository_test.dart` → PASS.
Run: `dart analyze lib/src/data/checkout` → no issues.

- [ ] **Step 5: Commit**

```bash
git add lib/src/data/checkout test/data/checkout
git commit -m "feat: checkout quote + public-coupons repository"
```

---

## Task 4: `couponCode` on the booking repository

**Files:** Modify `lib/src/data/booking/booking_api_repository.dart` + the `BookingRepository` interface (grep for `abstract class BookingRepository` / `abstract interface class BookingRepository`). Test: `test/data/booking/booking_api_repository_test.dart`.

- [ ] **Step 1: Add a failing test**

Append to `booking_api_repository_test.dart`:
```dart
test('bookSlots includes couponCode when set', () async {
  final dio = _MockDio();
  final repo = BookingApiRepository(dio);
  when(() => dio.post<Map<String, dynamic>>('/v1/consumer/bookings', data: any(named: 'data')))
      .thenAnswer((_) async => Response<Map<String, dynamic>>(
            requestOptions: RequestOptions(path: '/'),
            data: {'bookingId': 'b1', 'payment': {'orderId': 'o', 'keyId': 'k', 'amountPaise': 1, 'currency': 'INR'}},
          ));
  await repo.bookSlots(slotIds: ['s1'], customerName: 'A', customerContact: 'C', couponCode: 'SUMMER10');
  final body = verify(() => dio.post<Map<String, dynamic>>('/v1/consumer/bookings', data: captureAny(named: 'data')))
      .captured.single as Map<String, dynamic>;
  expect(body['couponCode'], 'SUMMER10');
});
```

- [ ] **Step 2: Update the interface + implementation**

In the `BookingRepository` interface, add `String? couponCode` to all three method signatures (matching the existing optional-param style). In `booking_api_repository.dart`:

```dart
@override
Future<SlotBookingResult> bookSlots({
  required List<String> slotIds,
  required String customerName,
  required String customerContact,
  String? note,
  String? couponCode,
}) async {
  final body = <String, dynamic>{'slotIds': slotIds, 'customerName': customerName, 'customerContact': customerContact};
  if (note != null && note.trim().isNotEmpty) body['note'] = note;
  if (couponCode != null && couponCode.trim().isNotEmpty) body['couponCode'] = couponCode.trim();
  final res = await _dio.post<Map<String, dynamic>>('/v1/consumer/bookings', data: body);
  return SlotBookingResult.fromJson(res.data!);
}

@override
Future<EventBookingResult> bookEvent(String eventId, {String? name, String? contact, String? couponCode}) async {
  final body = <String, dynamic>{};
  if (name != null && name.trim().isNotEmpty) body['name'] = name;
  if (contact != null && contact.trim().isNotEmpty) body['contact'] = contact;
  if (couponCode != null && couponCode.trim().isNotEmpty) body['couponCode'] = couponCode.trim();
  final res = await _dio.post<Map<String, dynamic>>('/v1/consumer/events/$eventId/book', data: body);
  return EventBookingResult.fromJson(res.data!);
}

@override
Future<MembershipPurchaseResult> purchaseMembership(String membershipId, {String? couponCode}) async {
  final body = <String, dynamic>{};
  if (couponCode != null && couponCode.trim().isNotEmpty) body['couponCode'] = couponCode.trim();
  final res = await _dio.post<Map<String, dynamic>>('/v1/consumer/memberships/$membershipId/purchase', data: body);
  return MembershipPurchaseResult.fromJson(res.data!);
}
```

- [ ] **Step 3: Run tests + analyze**

Run: `cd /Users/vedant/personal/circls && flutter test test/data/booking/booking_api_repository_test.dart` → PASS (existing + new).
Run: `dart analyze lib/src/data/booking` → no issues.

- [ ] **Step 4: Commit**

```bash
git add lib/src/data/booking test/data/booking
git commit -m "feat: thread couponCode through booking repository"
```

---

## Task 5: Shared widgets — `CheckoutBreakdown` + `CouponPicker`

**Files:** Create `lib/src/presentation/checkout/checkout_breakdown.dart`, `lib/src/presentation/checkout/coupon_picker.dart`.

- [ ] **Step 1: `checkout_breakdown.dart`** (uses theme tokens + `formatPaise`)

```dart
import 'package:flutter/material.dart';
import '../../core/format/money.dart'; // confirm the real import path for formatPaise (grep)
import '../../core/theme/colors.dart';
import '../../core/theme/tokens.dart';
import '../../domain/booking/checkout_quote.dart';

class CheckoutBreakdown extends StatelessWidget {
  const CheckoutBreakdown({super.key, required this.quote});
  final CheckoutQuote quote;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Column(
      children: [
        _row(text, 'Base price', formatPaise(quote.basePaise)),
        if (quote.discountPaise > 0)
          _row(text, 'Discount${quote.coupon != null ? ' (${quote.coupon!.code})' : ''}', '−${formatPaise(quote.discountPaise)}', accent: true),
        _row(text, 'Other charges (incl taxes)', formatPaise(quote.otherChargesPaise), muted: true),
        const Divider(height: Spacing.lg),
        _row(text, 'Total', formatPaise(quote.totalPaise), bold: true),
      ],
    );
  }

  Widget _row(TextTheme text, String label, String value, {bool muted = false, bool accent = false, bool bold = false}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: text.bodyMedium?.copyWith(color: muted ? CirclsColors.muted : CirclsColors.ink)),
          Text(value, style: (bold ? text.titleMedium : text.bodyMedium)?.copyWith(
              color: accent ? CirclsColors.accent : CirclsColors.ink, fontWeight: bold ? FontWeight.w700 : null)),
        ],
      ),
    );
  }
}
```

> Verify the real import path for `formatPaise` (the explorer found `money.dart`; grep `grep -rn "String formatPaise" lib`). Fix the import.

- [ ] **Step 2: `coupon_picker.dart`** — dropdown (public offers) + text field, emits the applied code

```dart
import 'package:flutter/material.dart';
import '../../core/theme/tokens.dart';
import '../../domain/booking/public_coupon.dart';
import '../widgets/circls_button.dart';

/// Pick a public offer from the dropdown OR type a code. Calls [onApply] with the
/// chosen/typed code, or [onClear] to remove. When [appliedCode] is set, shows a
/// compact "remove" affordance instead of the inputs.
class CouponPicker extends StatefulWidget {
  const CouponPicker({
    super.key,
    required this.offers,
    required this.appliedCode,
    required this.onApply,
    required this.onClear,
    this.busy = false,
  });
  final List<PublicCoupon> offers;
  final String? appliedCode;
  final void Function(String code) onApply;
  final VoidCallback onClear;
  final bool busy;

  @override
  State<CouponPicker> createState() => _CouponPickerState();
}

class _CouponPickerState extends State<CouponPicker> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (widget.appliedCode != null) {
      return Align(
        alignment: Alignment.centerLeft,
        child: TextButton(onPressed: widget.busy ? null : widget.onClear, child: Text('Remove coupon (${widget.appliedCode})')),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (widget.offers.isNotEmpty) ...[
          DropdownButtonFormField<String>(
            decoration: const InputDecoration(labelText: 'Available offers'),
            value: null,
            items: [
              const DropdownMenuItem<String>(value: null, child: Text('Select an offer…')),
              ...widget.offers.map((o) => DropdownMenuItem<String>(value: o.code, child: Text('${o.code} — ${o.offerLabel}'))),
            ],
            onChanged: widget.busy ? null : (code) { if (code != null) widget.onApply(code); },
          ),
          const SizedBox(height: Spacing.sm),
        ],
        Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Expanded(
              child: TextField(
                controller: _controller,
                textCapitalization: TextCapitalization.characters,
                decoration: const InputDecoration(labelText: 'Coupon code', hintText: 'Type a code'),
              ),
            ),
            const SizedBox(width: Spacing.sm),
            CirclsButton(
              label: 'Apply',
              busy: widget.busy,
              onPressed: () { final c = _controller.text.trim(); if (c.isNotEmpty) widget.onApply(c); },
            ),
          ],
        ),
      ],
    );
  }
}
```

> `CirclsButton` has no `size`/`variant` — if a smaller secondary style is wanted, use a `TextButton`/`OutlinedButton` for "Apply" instead. Keep it simple; match the app's button conventions.

- [ ] **Step 3: Analyze + commit**

Run: `cd /Users/vedant/personal/circls && dart analyze lib/src/presentation/checkout` → no issues.
```bash
git add lib/src/presentation/checkout/checkout_breakdown.dart lib/src/presentation/checkout/coupon_picker.dart
git commit -m "feat: checkout breakdown + coupon picker widgets"
```

---

## Task 6: Shared `confirmAndPay()` helper

**Files:** Create `lib/src/presentation/checkout/checkout_actions.dart`.

This books the item (with `couponCode`), then pays / confirms-free / shows-reserved, then navigates to `/confirmed`. Returns an error string (or null on success/navigation).

- [ ] **Step 1: Write the helper**

```dart
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../data/booking/booking_providers.dart';
import '../../data/profile/profile_providers.dart'; // confirm myProfileProvider's module (grep)
import '../../data/payments/razorpay_checkout.dart';
import '../../data/activity/activity_providers.dart'; // confirm activityLoggerProvider's module (grep)
import '../../domain/booking/checkout_item.dart';
import '../../domain/booking/checkout_quote.dart';

/// Books [item] (carrying [couponCode]), pays via Razorpay when needed, and
/// navigates to /confirmed. Returns an error message to display, or null when it
/// navigated (success/reserved) — the caller stops its busy spinner on return.
Future<String?> confirmAndPay({
  required WidgetRef ref,
  required BuildContext context,
  required CheckoutItem item,
  required CheckoutQuote quote,
  String? couponCode,
}) async {
  final profile = ref.read(myProfileProvider).valueOrNull;
  final name = profile?.displayName ?? 'Guest';
  final contact = profile?.phoneE164 ?? profile?.email ?? '';
  final booking = ref.read(bookingRepositoryProvider);

  // 1) Create the booking and normalize the Razorpay order + a confirmation id.
  String orderId = '';
  String keyId = '';
  int amountPaise = quote.totalPaise;
  String confirmId;
  String qrPrefix;
  switch (item) {
    case SlotCheckout(:final slotIds, :final note):
      final r = await booking.bookSlots(slotIds: slotIds, customerName: name, customerContact: contact, note: note, couponCode: couponCode);
      orderId = r.payment.orderId; keyId = r.payment.keyId; amountPaise = r.payment.amountPaise;
      confirmId = r.bookingId; qrPrefix = 'circls-booking';
    case EventCheckout(:final eventId):
      final r = await booking.bookEvent(eventId, name: name, contact: contact, couponCode: couponCode);
      orderId = r.orderId ?? ''; keyId = r.keyId ?? ''; amountPaise = r.amountPaise ?? 0;
      confirmId = r.booking.id; qrPrefix = 'circls-event';
    case MembershipCheckout(:final membershipId):
      final r = await booking.purchaseMembership(membershipId, couponCode: couponCode);
      orderId = r.orderId ?? ''; keyId = r.keyId ?? ''; amountPaise = r.amountPaise ?? 0;
      confirmId = r.userMembershipId; qrPrefix = 'circls-membership';
  }

  // 2) Free total ⇒ already confirmed. Otherwise pay (empty order ⇒ reserved/stub).
  var reserved = false;
  if (quote.totalPaise > 0) {
    final res = await RazorpayCheckout().open(CheckoutInput(
      keyId: keyId, orderId: orderId, amountPaise: amountPaise, currency: 'INR',
      description: item.title, prefillName: name, prefillContact: contact,
    ));
    if (!context.mounted) return null;
    switch (res.kind) {
      case CheckoutKind.paid:
        break;
      case CheckoutKind.reserved:
        reserved = true;
      case CheckoutKind.dismissed:
        return 'Payment cancelled. Your booking is held briefly — try again.';
      case CheckoutKind.failed:
        return res.message ?? 'Payment failed. Please try again.';
    }
  }

  if (!context.mounted) return null;
  ref.read(activityLoggerProvider).log('booking_created', itemType: qrPrefix, itemId: confirmId, props: {'amountPaise': quote.totalPaise});
  context.go('/confirmed', extra: {
    'title': reserved ? 'Reserved!' : "You're booked!",
    'subtitle': reserved ? "Payment isn't enabled yet — your booking is held." : 'Show this at the venue.',
    'heading': item.title,
    'qrData': '$qrPrefix:$confirmId',
    'caption': '#${confirmId.substring(0, confirmId.length.clamp(0, 8))}',
  });
  return null;
}
```

> Verify the real import paths/names for `myProfileProvider`, `activityLoggerProvider`, and the `/confirmed` extra keys (copy them verbatim from `review_screen.dart` / `event_detail_screen.dart`). Fix imports to match.

- [ ] **Step 2: Analyze + commit**

Run: `cd /Users/vedant/personal/circls && dart analyze lib/src/presentation/checkout/checkout_actions.dart` → no issues.
```bash
git add lib/src/presentation/checkout/checkout_actions.dart
git commit -m "feat: shared confirmAndPay checkout helper"
```

---

## Task 7: Slots — enhance `ReviewScreen`

**Files:** Modify `lib/src/presentation/booking/review_screen.dart`.

Add a live quote (base/discount/other charges/total) + `CouponPicker` (typed code only — no public-offers dropdown for slots) and route the Pay button through `confirmAndPay`.

- [ ] **Step 1: Make it quote-driven**

In `_ReviewScreenState`: add `CheckoutQuote? _quote;`, `String? _appliedCode;`. On `initState`/first build, fetch the quote:
```dart
Future<void> _loadQuote() async {
  setState(() { _busy = true; _error = null; });
  try {
    final item = SlotCheckout(slotIds: widget.slots.map((s) => s.id).toList(), title: '${widget.venueName} · ${widget.arenaName}', note: _note.text);
    final q = await ref.read(checkoutRepositoryProvider).getQuote(item, couponCode: _appliedCode);
    setState(() { _quote = q; _error = q.error != null ? _couponError(q.error!) : null; if (q.error != null) _appliedCode = null; });
  } catch (e) {
    setState(() => _error = 'Could not load pricing. Please try again.');
  } finally {
    if (mounted) setState(() => _busy = false);
  }
}
```
Call `_loadQuote()` from `initState` (after first frame) and whenever `_appliedCode` changes. Add a `_couponError(String code)` map (reuse the same friendly messages as the web `COUPON_ERRORS`).

- [ ] **Step 2: Render breakdown + coupon, route Pay through the helper**

Replace the hard-coded `Total` row + `_pay` body. Show the slot list (keep), then:
```dart
if (_quote != null) CheckoutBreakdown(quote: _quote!),
const SizedBox(height: Spacing.md),
CouponPicker(
  offers: const [], // slots: typed code only (public-offers endpoint is event/membership)
  appliedCode: _appliedCode,
  busy: _busy,
  onApply: (code) { setState(() => _appliedCode = code); _loadQuote(); },
  onClear: () { setState(() => _appliedCode = null); _loadQuote(); },
),
if (_error != null) ...[ const SizedBox(height: Spacing.md), Text(_error!, style: text.bodySmall?.copyWith(color: Theme.of(context).colorScheme.error)) ],
const SizedBox(height: Spacing.lg),
CirclsButton(
  label: _quote == null ? 'Loading…' : (_quote!.totalPaise == 0 ? 'Confirm' : 'Pay ${formatPaise(_quote!.totalPaise)}'),
  busy: _busy,
  onPressed: _quote == null ? null : _pay,
),
```
New `_pay`:
```dart
Future<void> _pay() async {
  final quote = _quote;
  if (quote == null) return;
  setState(() { _busy = true; _error = null; });
  try {
    final item = SlotCheckout(slotIds: widget.slots.map((s) => s.id).toList(), title: '${widget.venueName} · ${widget.arenaName}', note: _note.text);
    final err = await confirmAndPay(ref: ref, context: context, item: item, quote: quote, couponCode: _appliedCode);
    if (mounted && err != null) setState(() => _error = err);
  } catch (e) {
    if (mounted) setState(() => _error = 'Could not complete booking. Please try again.');
  } finally {
    if (mounted) setState(() => _busy = false);
  }
}
```
(Drop the old `_booking` retry cache + direct `RazorpayCheckout` call — `confirmAndPay` owns that now.)

- [ ] **Step 3: Analyze + run booking tests**

Run: `cd /Users/vedant/personal/circls && dart analyze lib/src/presentation/booking/review_screen.dart` → no issues.
Run any widget tests touching ReviewScreen: `flutter test test/` (or the specific file) → PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/src/presentation/booking/review_screen.dart
git commit -m "feat: transparent checkout + coupon on slot ReviewScreen"
```

---

## Task 8: Events + memberships — `CheckoutSheet`

**Files:** Create `lib/src/presentation/checkout/checkout_sheet.dart`; modify `event_detail_screen.dart`, `membership_detail_screen.dart`.

- [ ] **Step 1: Write the bottom sheet**

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/format/money.dart'; // formatPaise — fix path to match Task 5
import '../../core/theme/tokens.dart';
import '../../data/checkout/checkout_providers.dart';
import '../../domain/booking/checkout_item.dart';
import '../../domain/booking/checkout_quote.dart';
import '../../domain/booking/public_coupon.dart';
import '../widgets/circls_button.dart';
import 'checkout_actions.dart';
import 'checkout_breakdown.dart';
import 'coupon_picker.dart';

/// Opens the transparent checkout sheet for an event/membership.
Future<void> showCheckoutSheet(BuildContext context, CheckoutItem item) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: _CheckoutSheetBody(item: item),
    ),
  );
}

class _CheckoutSheetBody extends ConsumerStatefulWidget {
  const _CheckoutSheetBody({required this.item});
  final CheckoutItem item;
  @override
  ConsumerState<_CheckoutSheetBody> createState() => _CheckoutSheetBodyState();
}

class _CheckoutSheetBodyState extends ConsumerState<_CheckoutSheetBody> {
  CheckoutQuote? _quote;
  List<PublicCoupon> _offers = const [];
  String? _appliedCode;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
    _loadOffers();
  }

  Future<void> _load() async {
    setState(() { _busy = true; _error = null; });
    try {
      final q = await ref.read(checkoutRepositoryProvider).getQuote(widget.item, couponCode: _appliedCode);
      if (!mounted) return;
      setState(() { _quote = q; if (q.error != null) { _appliedCode = null; _error = _couponError(q.error!); } });
    } catch (e) {
      if (mounted) setState(() => _error = 'Could not load pricing. Please try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _loadOffers() async {
    final (type, id) = switch (widget.item) {
      EventCheckout(:final eventId) => ('event', eventId),
      MembershipCheckout(:final membershipId) => ('membership', membershipId),
      SlotCheckout() => ('', ''),
    };
    if (type.isEmpty) return;
    try {
      final rows = await ref.read(checkoutRepositoryProvider).getPublicCoupons(itemType: type, itemId: id);
      if (mounted) setState(() => _offers = rows);
    } catch (_) { /* offers are best-effort */ }
  }

  Future<void> _pay() async {
    final quote = _quote;
    if (quote == null) return;
    setState(() { _busy = true; _error = null; });
    try {
      final err = await confirmAndPay(ref: ref, context: context, item: widget.item, quote: quote, couponCode: _appliedCode);
      if (mounted && err != null) setState(() => _error = err);
      // success/reserved navigates to /confirmed; the sheet is popped by that nav.
    } catch (e) {
      if (mounted) setState(() => _error = 'Could not complete. Please try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(Spacing.gutter),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Checkout', style: text.titleLarge),
            const SizedBox(height: Spacing.xs),
            Text(widget.item.title, style: text.bodyMedium),
            const SizedBox(height: Spacing.lg),
            if (_quote != null) CheckoutBreakdown(quote: _quote!) else const Center(child: Padding(padding: EdgeInsets.all(Spacing.lg), child: CircularProgressIndicator())),
            const SizedBox(height: Spacing.md),
            CouponPicker(offers: _offers, appliedCode: _appliedCode, busy: _busy,
              onApply: (c) { setState(() => _appliedCode = c); _load(); },
              onClear: () { setState(() => _appliedCode = null); _load(); }),
            if (_error != null) ...[ const SizedBox(height: Spacing.md), Text(_error!, style: text.bodySmall?.copyWith(color: Theme.of(context).colorScheme.error)) ],
            const SizedBox(height: Spacing.lg),
            CirclsButton(
              label: _quote == null ? 'Loading…' : (_quote!.totalPaise == 0 ? 'Confirm' : 'Pay ${formatPaise(_quote!.totalPaise)}'),
              busy: _busy,
              onPressed: _quote == null ? null : _pay,
            ),
          ],
        ),
      ),
    );
  }
}

String _couponError(String code) => const {
  'coupon_not_found': 'That code isn’t valid.',
  'coupon_expired': 'That code has expired.',
  'coupon_not_started': 'That code isn’t active yet.',
  'coupon_inactive': 'That code is no longer active.',
  'coupon_scope_mismatch': 'That code doesn’t apply to this item.',
  'coupon_min_order': 'Your order is below this code’s minimum.',
  'coupon_max_redeemed': 'That code has been fully redeemed.',
  'coupon_user_limit': 'You’ve already used that code.',
}[code] ?? 'Coupon not applied.';
```

(Reuse the same `_couponError` map in `ReviewScreen` — extract to a shared file if you prefer DRY.)

- [ ] **Step 2: Wire the event Book button**

In `event_detail_screen.dart`, replace the `_book` direct booking with opening the sheet:
```dart
CirclsButton(
  label: e.pricePaise == 0 ? 'Register · Free' : 'Book · ${formatPaise(e.pricePaise)}',
  onPressed: () => showCheckoutSheet(context, EventCheckout(eventId: widget.eventId, title: e.name)),
),
```
Remove the now-unused `_book`/`_busy`/`_error` direct-Razorpay code (the sheet owns it). (Keep them only if other UI needs them.)

- [ ] **Step 3: Wire the membership Buy button**

In `membership_detail_screen.dart`:
```dart
CirclsButton(
  label: m.pricePaise == 0 ? 'Activate · Free' : 'Buy · ${formatPaise(m.pricePaise)}',
  onPressed: () => showCheckoutSheet(context, MembershipCheckout(membershipId: widget.membershipId, title: m.name)),
),
```
Remove the now-unused `_buy` direct code.

- [ ] **Step 4: Analyze + commit**

Run: `cd /Users/vedant/personal/circls && dart analyze lib/src/presentation/checkout lib/src/presentation/events lib/src/presentation/memberships` → no issues.
```bash
git add lib/src/presentation/checkout/checkout_sheet.dart lib/src/presentation/events/event_detail_screen.dart lib/src/presentation/memberships/membership_detail_screen.dart
git commit -m "feat: checkout sheet with coupons for events + memberships"
```

---

## Task 9: Full verification

- [ ] **Step 1: Codegen is current**

Run: `cd /Users/vedant/personal/circls && dart run build_runner build --delete-conflicting-outputs` → no errors (regenerates Freezed/json for the new models).

- [ ] **Step 2: Analyze the whole app**

Run: `cd /Users/vedant/personal/circls && dart analyze` → **No issues found.**

- [ ] **Step 3: Run the test suite**

Run: `cd /Users/vedant/personal/circls && flutter test` → all pass (incl. the new checkout repo tests + the couponCode booking test).

- [ ] **Step 4: Build smoke (optional, catches platform issues)**

Run: `cd /Users/vedant/personal/circls && flutter build apk --debug` (or `flutter build ios --no-codesign` on macOS) → succeeds.

- [ ] **Step 5: Manual smoke (device/emulator + the live API)**

- Open a paid event → sheet shows Base / Other charges (incl taxes) / Total (₹X.XX shows 2 decimals via `formatPaise`); pick a public offer from the dropdown → discount row appears, total drops; type an invalid code → inline error, total unchanged; Pay → Razorpay (or "Reserved" if payments disabled) → Confirmed screen.
- Free event / 100%-off coupon → button reads "Confirm"; confirms without Razorpay.
- Slot flow: select slots → Review shows breakdown + typed-coupon field (no offers dropdown) → Pay.
- Membership → same as event.

- [ ] **Step 6: Final commit (if codegen/build tweaks were needed)**

```bash
git add -A && git commit -m "chore: flutter coupon checkout verification"
```

---

## Self-Review notes (for the implementer)

- **Bind to the live contract** at the top. The quote endpoint is the only source of displayed pricing — never compute the gross-up in Dart. The booking endpoints re-validate the coupon server-side.
- **Verify real import paths/names before coding** (the explorer's paths are a guide): `formatPaise` (`grep -rn "String formatPaise" lib`), `myProfileProvider`, `activityLoggerProvider`, `bookingRepositoryProvider`, the `BookingRepository` interface location, and the `/confirmed` route's `extra` keys (copy verbatim from `review_screen.dart`).
- **Flutter `formatPaise` already shows 2 decimals** for fractional rupees, so the gross-up (e.g. ₹358.47) displays correctly — no display fix needed here (unlike the web app, which needed `formatPaiseExact`).
- **Offers dropdown is event/membership only** — slots pass `offers: const []` (the `GET /v1/consumer/coupons` endpoint doesn't support slots). Intended, not a gap.
- **`confirmAndPay` navigates on success/reserved**; the bottom sheet is dismissed by that `context.go('/confirmed')`. On dismissed/failed/quote-error it returns a message and the sheet/screen stays open.
- **Codegen**: every Freezed model needs `dart run build_runner build` and the generated `.freezed.dart` / `.g.dart` committed (this repo commits generated files — verify by checking an existing model's `.g.dart` is tracked).
- This plan targets the **`/Users/vedant/personal/circls` repo** and is its own branch/PR; it depends on the Plan 1 backend already being live (it is).
```
