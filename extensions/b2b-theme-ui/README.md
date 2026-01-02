# B2B Theme UI Extension

This extension adds multiple blocks to integrate your B2B Dashboard with your Shopify theme.

## 📦 What's Included

This theme app extension provides **3 customizable blocks**:

### 1. **B2B Dashboard Button** (`dashboard_button.liquid`)
- Opens dashboard in a beautiful modal popup
- Fully customizable colors, sizes, and styles
- Smooth animations and responsive design
- Perfect for navigation, headers, or account pages

### 2. **B2B Dashboard Embed** (`dashboard_embed.liquid`)
- Embeds the full dashboard directly in any page
- Includes loading states and error handling
- Customizable header and styling options
- Best for dedicated dashboard pages

### 3. **B2B Dashboard Card** (`dashboard_card.liquid`)
- Promotional card with gradient backgrounds
- Feature list with checkmarks
- Call-to-action button
- Great for account pages or customer portals

## 🚀 How It Works

All blocks load your B2B Dashboard via the **App Proxy** route:
```
https://yourstore.com/apps/b2b-portal/dashboard
```

The dashboard runs in an `<iframe>` which provides:
- ✅ Security isolation
- ✅ Full React functionality preserved
- ✅ All your dashboard routes work
- ✅ No theme conflicts

## 📝 Setup Instructions

### Step 1: Deploy the Extension

```bash
npm run deploy
```

### Step 2: Activate in Theme Editor

1. Go to **Online Store > Themes** in Shopify Admin
2. Click **Customize** on your active theme
3. Navigate to any section
4. Click **Add block** or **Add section**
5. Look for **B2B Dashboard** blocks in the "Apps" section
6. Add the block(s) you want

### Step 3: Customize

Each block has extensive customization options in the theme editor:
- Colors and typography
- Spacing and sizing
- Text content
- Button styles
- And more!

## 🎨 Block Usage Examples

### Dashboard Button (Modal)
**Best for:** Navigation menus, floating buttons, quick access

The button opens your dashboard in a modal overlay without leaving the current page.

**Where to add:**
- Header/navigation
- Account page
- Floating button (bottom right)
- Any section where you want quick dashboard access

### Dashboard Embed
**Best for:** Dedicated dashboard pages

Embeds the full dashboard directly in the page content.

**Where to add:**
- Create a new page template
- Add to account pages
- Full-width sections
- Dedicated B2B portal pages

### Dashboard Card
**Best for:** Promotional/feature cards

A visually appealing card that links to the dashboard.

**Where to add:**
- Account overview page
- Customer portal homepage
- B2B landing pages
- Feature showcases

## 🔒 Security Features

All blocks automatically check if the customer:
1. Is logged in (`{% if customer %}`)
2. Has B2B access (`customer.tags contains 'b2b'`)

Non-B2B customers see either:
- Nothing (blocks don't render)
- Access restricted message (configurable)

## 🎯 Customization Tips

### Change Customer Tag Check

If you use a different tag system, modify the condition in each block:

```liquid
{% if customer and customer.tags contains 'YOUR_TAG' %}
```

### Use Direct Links Instead of Modal

In `dashboard_button.liquid`, change:
```liquid
<button onclick="openB2BDashboard()">
```
To:
```liquid
<a href="/apps/b2b-portal/dashboard">
```

### Customize Modal Behavior

Edit the JavaScript in `dashboard_button.liquid`:
- Change modal width: `max-width: 1400px`
- Change modal height: `height: 90vh`
- Add custom close behavior
- Modify animations

### Load Dashboard in New Tab

Add `target="_blank"` to any link:
```liquid
<a href="/apps/b2b-portal/dashboard" target="_blank">
```

## 🧪 Testing

1. **Test as B2B Customer:**
   - Log in as a customer with the `b2b` tag
   - Verify blocks appear correctly
   - Test dashboard functionality

2. **Test as Regular Customer:**
   - Log in as a regular customer
   - Verify blocks don't appear (or show access message)

3. **Test Modal:**
   - Click button
   - Verify modal opens
   - Test close button
   - Test ESC key
   - Test background click

## 🐛 Troubleshooting

### Dashboard Not Loading
- Verify app proxy is configured correctly
- Check that `/apps/b2b-portal/dashboard` is accessible
- Review browser console for errors

### Blocks Not Appearing in Theme Editor
- Run `npm run deploy` to deploy extension
- Refresh theme editor
- Check extension is activated in the app settings

### Customer Tag Not Working
- Verify customer has the correct tag in Shopify admin
- Check tag name matches exactly (case-sensitive)
- Update tag check in block files if using different tag

### Modal Styling Issues
- Check for CSS conflicts with theme
- Adjust z-index values if modal appears behind elements
- Modify modal animations if they conflict with theme

## 📚 Related Files

- Main dashboard route: `/app/routes/dashboard.tsx`
- Proxy setup: `/app/routes/proxy.tsx`
- App config: `/shopify.app.toml`
- Theme examples: `/examples/theme-integration.liquid`
- Setup guide: `/Doc/DASHBOARD_INTEGRATION_GUIDE.md`

## 🔄 Updates

To update the extension after making changes:

```bash
npm run deploy
```

Changes will be reflected immediately in the theme editor.

## 💡 Advanced Usage

### Load Specific Dashboard Pages

Modify iframe src to load specific routes:

```liquid
iframe.src = '/apps/b2b-portal/dashboard/ordermanagement';
```

Available routes:
- `/apps/b2b-portal/dashboard` - Overview
- `/apps/b2b-portal/dashboard/usermanagement`
- `/apps/b2b-portal/dashboard/location`
- `/apps/b2b-portal/dashboard/ordermanagement`
- `/apps/b2b-portal/dashboard/wishlist`
- `/apps/b2b-portal/dashboard/creditmangement`
- `/apps/b2b-portal/dashboard/notification`
- `/apps/b2b-portal/dashboard/setting`

### Custom Event Communication

Add postMessage communication between iframe and parent:

```javascript
// In parent page
iframe.contentWindow.postMessage({ action: 'navigate', page: 'orders' }, '*');

// In your dashboard app
window.addEventListener('message', (event) => {
  if (event.data.action === 'navigate') {
    // Handle navigation
  }
});
```

## 🤝 Support

For issues or questions:
1. Check documentation in `/Doc/` folder
2. Review proxy setup in `PROXY_SETUP.md`
3. Test app proxy accessibility
4. Check browser console for errors

---

**Created for B2B Portal by Dynamic Dreamz**
