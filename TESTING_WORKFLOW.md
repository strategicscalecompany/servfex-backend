# Temporary Expert Testing Workflow

This is an isolated testing alternative for Expert portals. The original dispatch, assignment, and Service Professional implementation remains in the repository.

## Enable / disable

Set in `servfex admin/be/.env`:

```
EXPERT_TESTING_WORKFLOW_ENABLED=true
```

Set to `false` and restart the backend to restore the original workflow. No deleted code needs to be reconstructed.

Default is `true` while this testing stage is active.

## What the flag isolates (does not delete)

When enabled, these original connections are skipped:

1. `startDispatchWorker()` in `src/services/dispatch.worker.ts`
2. `processBookingDispatch()` auto-assign / offer-expiry in `src/services/dispatch.service.ts`
3. Immediate re-dispatch after `rejectAssignment()`
4. Unassigned Expert job pool on `GET /vendor/orders`
5. Broadcast assign (`POST /vendor/orders/:id/assign` without `employeeId`)
6. Completion via generic `PATCH /vendor/orders/:id/status` (`IN_PROGRESS` / `COMPLETED`)

The original functions, worker, scheduler, and ranking rules stay in place.

## What the temporary workflow adds

- `EmployeeProfile.expertKind`: `SERVICE_PROFESSIONAL` (default) or `SALES_MANAGER`
- `SalesVisit` lead records
- `Booking.completionPhotoUrls`
- `BookingSource.SALES_MANAGER`
- Sales Manager portal (Visits + Bookings) in the vendor app
- Service Professional completion requires **4 hosted photographs** plus the existing left-to-right swipe
- Provider assignment only to Service Professionals

## Restore original workflow

1. Set `EXPERT_TESTING_WORKFLOW_ENABLED=false`
2. Restart the backend
3. Existing Sales Manager accounts keep `expertKind = SALES_MANAGER` but are treated as regular Experts for assignment/login routing
4. Existing visits, completion photos, and Sales Manager bookings remain in the database

## Schema notes

All schema changes are additive and backward compatible:

- New enum values / columns have defaults
- Existing employees become Service Professionals
- Historic bookings have empty `completionPhotoUrls`
