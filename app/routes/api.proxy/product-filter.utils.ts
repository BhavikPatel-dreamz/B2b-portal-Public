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

export type FilterCriteria = {
  color?: string;
  size?: string;
  minPrice?: number | null;
  maxPrice?: number | null;
};

export function filterEdgesByCriteria(
  edges: { node: ShopifyProductNode }[],
  criteria: FilterCriteria,
): { node: ShopifyProductNode }[] {
  return edges
    .map((edge) => {
      const filteredVariants = edge.node.variants.edges.filter(
        ({ node: variant }) => {
          let matchesColor = !criteria.color;
          let matchesSize = !criteria.size;
          let matchesMinPrice = criteria.minPrice == null;
          let matchesMaxPrice = criteria.maxPrice == null;

          variant.selectedOptions?.forEach((option) => {
            if (
              criteria.color &&
              option.name.toLowerCase() === "color" &&
              option.value === criteria.color
            ) {
              matchesColor = true;
            }
            if (
              criteria.size &&
              option.name.toLowerCase() === "size" &&
              option.value === criteria.size
            ) {
              matchesSize = true;
            }
          });

          const priceNumber = Number(variant.price);
          if (criteria.minPrice != null && !Number.isNaN(priceNumber)) {
            matchesMinPrice = priceNumber >= criteria.minPrice;
          }
          if (criteria.maxPrice != null && !Number.isNaN(priceNumber)) {
            matchesMaxPrice = priceNumber <= criteria.maxPrice;
          }

          return (
            matchesColor && matchesSize && matchesMinPrice && matchesMaxPrice
          );
        },
      );

      return {
        node: {
          ...edge.node,
          variants: {
            edges: filteredVariants,
          },
        },
      };
    })
    .filter((edge) => edge.node.variants.edges.length > 0);
}

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
