declare module "*.css";

// Declare Shopify custom elements
declare namespace JSX {
  interface IntrinsicElements {
    "s-page": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement> & { heading?: string }, HTMLElement>;
    "s-section": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement> & { heading?: string }, HTMLElement>;
    "s-button": React.DetailedHTMLProps<React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }, HTMLButtonElement>;
    "s-banner": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement> & { tone?: string; title?: string }, HTMLElement>;
    "s-paragraph": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
  }
}
