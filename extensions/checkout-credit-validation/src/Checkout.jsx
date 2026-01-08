import {
  extension,
  Banner
} from '@shopify/ui-extensions/checkout';

export default extension('purchase.checkout.block.render', (root, { settings }) => {
  const banner = root.createComponent(Banner, {
    status: 'info',
  });

  banner.appendChild('B2B Credit Validation: Your order will be validated after payment.');

  root.appendChild(banner);
});
