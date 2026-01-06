# Company Sync Feature Implementation

## Overview
Implemented a complete Company Sync workflow that fetches Shopify B2B companies and imports them into the system with email notifications.

## Features Implemented

### 1. **Company Sync Button** (app.companies.tsx)
- Added a "Company Sync" button in the companies list page
- Triggers an action that syncs all Shopify B2B companies
- Shows loading state during sync

### 2. **Shopify B2B Company Fetching** (app.companies.tsx)
- GraphQL query to fetch all companies from Shopify B2B
- Retrieves company details:
  - Company ID and name
  - Main contact information (name, email, phone)
  - Company locations
  - External ID

### 3. **Data Import to Prisma Database** (app.companies.tsx)
- Upserts company data to `CompanyAccount` model
- Maps Shopify data to local database:
  - `shopifyCompanyId`: Shopify company GID
  - `name`: Company name
  - `contactName`: Contact full name (first + last)
  - `contactEmail`: Contact email
  - `creditLimit`: Default to 0

### 4. **Email Notifications** (notification.server.ts)
- New `sendCompanyWelcomeEmail()` function
- Sends HTML and plain text emails with:
  - Company name
  - Primary contact information
  - Confirmation that company was synced
- Email template includes professional HTML formatting

### 5. **Settings Page Configuration** (app.settings.tsx)
- Added Company Sync Settings section with three new fields:

#### a. Company Sync Notifications Toggle
- Enable/disable email notifications when companies are synced
- Checkbox control
- Default: enabled

#### b. Company Welcome Email Notes
- Textarea for custom message/notes
- Included in sync notification emails
- Supports plain text
- Optional field

#### c. Settings Persistence
- All settings saved to Store model
- Configurable per store/shop
- Persisted in database

### 6. **Database Schema Updates** (prisma/schema.prisma)
Added three new fields to the `Store` model:
```prisma
companyWelcomeEmailTemplate String?     // Custom notes/message
companyWelcomeEmailEnabled Boolean      // Toggle notifications on/off
```

## Workflow Steps

When user clicks "Company Sync" button:

1. **Fetch Companies** - GraphQL query retrieves all Shopify B2B companies
2. **Check User Exists** - Validates main contact has email
3. **Create/Update Contacts** - Maps Shopify contact to system (ready for main contact assignment if needed)
4. **Import to Database** - Upserts company data to Prisma database
5. **Send Notifications** - Sends welcome email to configured notification email
6. **Provide Feedback** - Shows success/error message with count of synced companies

## Data Flow

```
User clicks "Company Sync"
    ↓
Fetch from Shopify B2B via GraphQL
    ↓
For each company:
  - Check if main contact exists
  - Upsert to CompanyAccount table
  - Send welcome email (if enabled)
    ↓
Return summary with sync count and any errors
```

## Configuration

All settings are configured in the Settings page:
- **Settings Page**: `/app/settings`
- **Field Names**:
  - `companyWelcomeEmailEnabled` (checkbox)
  - `companyWelcomeEmailTemplate` (textarea)

## Files Modified

### Frontend/Routes
- `app/routes/app.companies.tsx` - Added sync action and UI
- `app/routes/app.settings.tsx` - Added company sync settings

### Services
- `app/services/notification.server.ts` - Added email function
- `app/services/store.server.ts` - Updated type definitions

### Database
- `prisma/schema.prisma` - Added new Store fields
- `prisma/migrations/20260106130003_add_company_sync_settings/` - New migration

## Error Handling

The sync process:
- Handles missing companies gracefully
- Continues processing if individual company fails
- Returns error details for each failed sync
- Shows total count of successfully synced companies
- Displays any errors in banner notification

## Future Enhancements

1. **Email Service Integration** - Replace console.log with actual email sending (SendGrid, AWS SES, etc.)
2. **Custom Email Templates** - Support HTML template with variables
3. **Sync History** - Track when companies were synced
4. **Bulk Operations** - Resume/retry failed syncs
5. **Webhook Integration** - Auto-sync on Shopify company creation
6. **Approval Workflow** - Review before importing
