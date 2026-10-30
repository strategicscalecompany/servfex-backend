# ServFex Order Assignment & Service Execution

Customer-created bookings and manager-created bookings use **different assignment strategies** and the **same execution lifecycle** after a professional accepts. There is no separate Order model — everything stays on `Booking`.

## Architecture distinction

- **Workflow A (customer app):** radius vendor routing, 2-minute vendor window, then automatic professional assignment. If the customer is outside every vendor radius, scored nearest-professional search runs immediately.
- **Workflow B (Hub Operation Manager / Sales Manager):** `DIRECT_EXPERT` assignment. No radius matching, no 2-minute timeout, no auto-dispatch.
- **Shared after `ACCEPTED`:** ETA, live tracking, Agora, in-app chat, arrival, 4-digit PIN, ≥4 photos, UPI amount QR, completion swipe, missed-call escalation.

## Assignment strategies

| Source | Strategy | Auto-dispatch | 2-minute vendor window | Radius routing |
|---|---|---|---|---|
| Customer App (`CUSTOMER_APP`) inside a vendor radius | `VENDOR_WINDOW` | Yes, after `PROVIDER_RESPONSE_WINDOW_SECONDS` (default 120s) | Yes | Yes |
| Customer App outside every vendor radius | `NEAREST_EXPERT` | Immediate scored search across nearby professionals | No | Nearby professionals, not hub-only |
| Hub Operation Manager (`PHONE_HUB`) | `DIRECT_EXPERT` | No | No | No |
| Sales Manager (`SALES_MANAGER`) | `DIRECT_EXPERT` | No | No | No |

Existing `BookingStatus` values are preserved. Suggested product states map onto them:

- CREATED / PENDING_VENDOR → `PENDING`
- PENDING_PROFESSIONAL → `ASSIGNED`
- ACCEPTED / PROFESSIONAL_ON_THE_WAY → `ON_THE_WAY` / ARRIVED / IN_PROGRESS / AWAITING_PAYMENT / COMPLETED / CANCELLED / DECLINED
- PIN and photos are gates, not extra statuses
- Escalation is a ticket overlay, not a booking status

## Shared execution lifecycle

`ASSIGNED → ACCEPTED → ON_THE_WAY → ARRIVED → PIN → IN_PROGRESS → photos (≥4) → AWAITING_CUSTOMER_CONFIRMATION → AWAITING_PAYMENT / COMPLETED`

Concurrency: assignment uses `prisma.$transaction` + conditional `updateMany` so a vendor manual assign and the 2-minute auto-assign cannot both win.

## New / updated APIs

### Customer
- `GET /customer/bookings/active`
- `GET /customer/bookings/:id/tracking`
- `GET|POST /customer/bookings/:id/messages`

### Vendor / professional / hub manager
- `POST /vendor/orders/:id/location`
- `GET /vendor/orders/:id/tracking`
- `GET|POST /vendor/orders/:id/messages`
- `GET /vendor/orders/:id/payment-qr` (backend-calculated amount; QR display ≠ paid)
- `GET /vendor/me/professional`
- `PATCH /vendor/me/availability`
- `PATCH /vendor/me/upi`
- `GET /vendor/escalations`
- `POST /vendor/escalations/:id/resolve`
- `PATCH /vendor/orders/:id/status` accepts `etaMinutes` on `ACCEPTED`

## Socket.IO

Existing rooms `user:<id>` and `admins` plus optional `booking:<id>` after `booking:join` / `booking:leave`.

Events: `booking:new`, `booking:updated`, `booking:assignment`, `booking:location`, `booking:chat`, `booking:escalation`, `call:incoming`, `call:answered`, `call:declined`, `call:ended`.

Socket payloads stay identifiers/status only. Clients refetch REST for personal data, chat bodies, and coordinates.

## Configurable knobs

`PROVIDER_RESPONSE_WINDOW_SECONDS` (120), `OUT_OF_RADIUS_MAX_DISTANCE_KM` (25), `AVG_TRAVEL_SPEED_KMH` (25), `START_OTP_MAX_ATTEMPTS` (5), `START_OTP_EXPIRY_MINUTES` (180), `START_OTP_LOCKOUT_MINUTES` (15), `MISSED_CALL_ESCALATION_THRESHOLD` (4), `LOCATION_PING_MIN_INTERVAL_MS` (8000).

## Database (Prisma / Mongo)

Extended existing models — no duplicate Order collection.

- `EmployeeProfile`: `acceptingRequests`, `lastLatitude/Longitude/LocationAt`, `upiId`
- `Booking`: `assignmentStrategy`, `etaMinutes`, `startOtpAttempts`, `missedCallCount`, `locationSharingEnabled`, professional last location, `outOfRadiusDispatch`
- New: `BookingMessage`, `BookingPhoto`, `EscalationTicket`, `EscalationAction`
- Enums: `AssignmentStrategy`, `EscalationStatus`, `EscalationReason`, `ChatSenderRole`, `PhotoCategory`

Apply with `npx prisma generate` and `npx prisma db push` (Mongo has no SQL migrations).

## Privacy

- Professional REST payloads never include customer phone/email.
- Customer REST payloads never include professional phone.
- Agora `peerPhone` is always empty. Calls use order-scoped channels and tokens.
- Chat is order-scoped; access ends when status leaves the callable window.
- Location sharing is enabled on accept and cleared on complete/cancel.

## Remaining product gaps

- Android apps still poll REST rather than consuming Socket.IO client events.
- Incoming Agora ring UI is not a full native incoming-call screen.
- Google Directions API is not used; ETA uses haversine + configured speed.
- UPI QR display is not a verified payment webhook. Cash/UPI still need authorized reconciliation before `PaymentStatus.PAID`.
