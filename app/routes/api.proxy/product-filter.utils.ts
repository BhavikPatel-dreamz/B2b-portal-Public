type SelectedOption = {
  name: string;
  value: string;
};

type VariantNode = {
  price?: string;
  availableForSale?: boolean;
  selectedOptions?: SelectedOption[];
};

type VariantEdge = { node: VariantNode };

type ShopifyProductNode = {
  vendor?: string;
  productType?: string;
  tags?: string[];
  variants: { edges: VariantEdge[] };
};

export type FilterOptions = {
  vendors: string[];
  productTypes: string[];
  tags: string[];
  colors: string[];
  sizes: string[];
  priceRange: {
    min: number;
    max: number;
  };
  hasAvailableProducts: boolean;
};

export function buildFiltersFromEdges(
  edges: { node: ShopifyProductNode }[],
): FilterOptions {
  const vendorSet = new Set<string>();
  const productTypeSet = new Set<string>();
  const tagSet = new Set<string>();
  const colorSet = new Set<string>();
  const sizeSet = new Set<string>();
  let minPriceValue = Number.POSITIVE_INFINITY;
  let maxPriceValue = 0;
  let hasAvailableProducts = false;

  edges.forEach((edge) => {
    const node = edge.node;

    if (node.vendor) {
      vendorSet.add(node.vendor);
    }

    if (node.productType) {
      productTypeSet.add(node.productType);
    }

    node.tags?.forEach((tagValue) => {
      if (tagValue) tagSet.add(tagValue);
    });

    node.variants.edges.forEach(({ node: v }) => {
      const priceNumber = Number(v.price);
      if (!Number.isNaN(priceNumber)) {
        minPriceValue = Math.min(minPriceValue, priceNumber);
        maxPriceValue = Math.max(maxPriceValue, priceNumber);
      }
      if (v.availableForSale) {
        hasAvailableProducts = true;
      }

      v.selectedOptions?.forEach((option) => {
        if (option.name.toLowerCase() === "color") {
          colorSet.add(option.value);
        }
        if (option.name.toLowerCase() === "size") {
          sizeSet.add(option.value);
        }
      });
    });
  });

  return {
    vendors: Array.from(vendorSet).sort(),
    productTypes: Array.from(productTypeSet).sort(),
    tags: Array.from(tagSet).sort(),
    colors: Array.from(colorSet).sort(),
    sizes: Array.from(sizeSet).sort(),
    priceRange: {
      min: minPriceValue === Number.POSITIVE_INFINITY ? 0 : minPriceValue,
      max: maxPriceValue,
    },
    hasAvailableProducts,
  };
}
