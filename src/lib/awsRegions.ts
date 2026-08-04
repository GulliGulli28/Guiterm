/**
 * The AWS regions, with the place names people actually use to refer to them.
 *
 * A static list, deliberately. Asking AWS for the authoritative one
 * (`ec2 describe-regions`) needs working credentials, which is precisely what
 * may not be true yet when a region has to be picked — choosing a region is
 * part of *getting* those credentials working. So the list is carried here and
 * the field accepts anything not in it (see `RegionSelect`), which is what
 * keeps a region newer than this app usable.
 *
 * GovCloud and China are included: they are separate partitions, and someone
 * working in one has no other way to reach it from a fixed list.
 */
export interface AwsRegion {
  id: string;
  /** The city or area AWS names it after — the half anyone remembers. */
  label: string;
  /** Grouping for the picker; also what tells the partitions apart. */
  area: string;
}

export const AWS_REGIONS: AwsRegion[] = [
  { id: "us-east-1", label: "N. Virginie", area: "Amérique du Nord" },
  { id: "us-east-2", label: "Ohio", area: "Amérique du Nord" },
  { id: "us-west-1", label: "Californie du Nord", area: "Amérique du Nord" },
  { id: "us-west-2", label: "Oregon", area: "Amérique du Nord" },
  { id: "ca-central-1", label: "Canada central", area: "Amérique du Nord" },
  { id: "ca-west-1", label: "Calgary", area: "Amérique du Nord" },
  { id: "mx-central-1", label: "Mexique", area: "Amérique du Nord" },

  { id: "sa-east-1", label: "São Paulo", area: "Amérique du Sud" },

  { id: "eu-west-1", label: "Irlande", area: "Europe" },
  { id: "eu-west-2", label: "Londres", area: "Europe" },
  { id: "eu-west-3", label: "Paris", area: "Europe" },
  { id: "eu-central-1", label: "Francfort", area: "Europe" },
  { id: "eu-central-2", label: "Zurich", area: "Europe" },
  { id: "eu-north-1", label: "Stockholm", area: "Europe" },
  { id: "eu-south-1", label: "Milan", area: "Europe" },
  { id: "eu-south-2", label: "Espagne", area: "Europe" },

  { id: "il-central-1", label: "Tel Aviv", area: "Moyen-Orient et Afrique" },
  { id: "me-south-1", label: "Bahreïn", area: "Moyen-Orient et Afrique" },
  { id: "me-central-1", label: "Émirats arabes unis", area: "Moyen-Orient et Afrique" },
  { id: "af-south-1", label: "Le Cap", area: "Moyen-Orient et Afrique" },

  { id: "ap-east-1", label: "Hong Kong", area: "Asie-Pacifique" },
  { id: "ap-south-1", label: "Mumbai", area: "Asie-Pacifique" },
  { id: "ap-south-2", label: "Hyderabad", area: "Asie-Pacifique" },
  { id: "ap-northeast-1", label: "Tokyo", area: "Asie-Pacifique" },
  { id: "ap-northeast-2", label: "Séoul", area: "Asie-Pacifique" },
  { id: "ap-northeast-3", label: "Osaka", area: "Asie-Pacifique" },
  { id: "ap-southeast-1", label: "Singapour", area: "Asie-Pacifique" },
  { id: "ap-southeast-2", label: "Sydney", area: "Asie-Pacifique" },
  { id: "ap-southeast-3", label: "Jakarta", area: "Asie-Pacifique" },
  { id: "ap-southeast-4", label: "Melbourne", area: "Asie-Pacifique" },

  { id: "us-gov-east-1", label: "GovCloud Est", area: "Partitions séparées" },
  { id: "us-gov-west-1", label: "GovCloud Ouest", area: "Partitions séparées" },
  { id: "cn-north-1", label: "Pékin", area: "Partitions séparées" },
  { id: "cn-northwest-1", label: "Ningxia", area: "Partitions séparées" },
];

/** The regions grouped for a picker, in the order declared above. */
export function regionsByArea(): { area: string; regions: AwsRegion[] }[] {
  const groups: { area: string; regions: AwsRegion[] }[] = [];
  for (const region of AWS_REGIONS) {
    const existing = groups.find((group) => group.area === region.area);
    if (existing) existing.regions.push(region);
    else groups.push({ area: region.area, regions: [region] });
  }
  return groups;
}

/** Whether `id` is one this build knows about — anything else still works,
 * it just has no place name to show. */
export function isKnownRegion(id: string): boolean {
  return AWS_REGIONS.some((region) => region.id === id);
}
