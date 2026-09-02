export interface ActorInput {
  keywords?: string[];
  locations?: string[];
  categoryId?: string;
  minPrice?: number;
  maxPrice?: number;
  maxResults?: number;
  includeItemDetails?: boolean;
  includeDescription?: boolean;
  proxyConfiguration?: Record<string, unknown>;
}

export interface NormalizedInput {
  keywords: string[];
  locations: string[];
  categoryId?: string;
  minPrice?: number;
  maxPrice?: number;
  maxResults: number;
  includeItemDetails: boolean;
  includeDescription: boolean;
  proxyConfiguration: Record<string, unknown>;
}

export interface LocationTarget {
  query?: string;
  id?: string;
  name?: string;
  type?: string;
}

export interface OlxLocationSuggestion {
  id: number | string;
  name: string;
  type: string;
  addressComponents?: Array<{
    id: number | string;
    type: string;
    name: string;
  }>;
}

export interface OlxLocationResponse {
  data?: {
    input?: string;
    suggestions?: OlxLocationSuggestion[];
  };
}

export interface OlxImageVariant {
  url?: string;
  width?: number;
  height?: number;
}

export interface OlxImage {
  url?: string;
  small?: OlxImageVariant;
  medium?: OlxImageVariant;
  big?: OlxImageVariant;
  full?: OlxImageVariant;
}

export interface OlxParameter {
  key?: string;
  key_name?: string;
  value?: string | number | boolean | null;
  value_name?: string | number | boolean | null;
  formatted_value?: string | number | boolean | null;
}

export interface OlxRawListing {
  id?: string;
  ad_id?: string;
  title?: string;
  description?: string;
  category_id?: string;
  user_type?: string;
  is_business?: boolean;
  elite_seller?: boolean;
  is_kyc_verified_user?: boolean;
  has_phone_param?: boolean;
  created_at?: string;
  created_at_first?: string;
  display_date?: string;
  valid_to?: string | null;
  price?: {
    value?: {
      raw?: number;
      display?: string;
      currency?: {
        iso_4217?: string;
      };
    };
  };
  status?: {
    status?: string;
    display?: string;
    translated_display?: string;
  };
  locations_resolved?: Record<string, string | number | undefined>;
  locations?: Array<{
    lat?: number;
    lon?: number;
  }>;
  favorites?: {
    count?: number;
  };
  images?: OlxImage[];
  videos?: unknown[];
  parameters?: OlxParameter[];
  views?: number;
  calls?: number;
  replies?: number;
}

export interface OlxSearchResponse {
  data?: OlxRawListing[];
  metadata?: {
    total_ads?: number;
    total_pages?: number;
    next_page_url?: string;
    filters?: Array<Record<string, unknown>>;
  };
}

export interface OlxItemResponse {
  data?: OlxRawListing;
}

export interface OlxListingRecord {
  source: 'olx';
  searchQuery: string;
  locationQuery: string | null;
  listingId: string;
  title: string;
  categoryId: string | null;
  category: string | null;
  price: number | null;
  priceDisplay: string | null;
  currency: string | null;
  sellerType: string | null;
  isBusiness: boolean | null;
  eliteSeller: boolean | null;
  isKycVerified: boolean | null;
  hasPhoneParam: boolean | null;
  description?: string | null;
  status: string | null;
  state: string | null;
  city: string | null;
  area: string | null;
  location: string | null;
  latitude: number | null;
  longitude: number | null;
  postedAt: string | null;
  createdAt: string | null;
  validTo: string | null;
  imageUrl: string | null;
  imageCount: number;
  videoCount: number;
  favoriteCount: number | null;
  listingUrl: string;
  parameters: Record<string, string | number | boolean | null>;
  scrapedAt: string;
}
