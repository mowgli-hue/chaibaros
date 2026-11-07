export const CHANNEL_LABEL: Record<string, string> = {
  counter: "Counter",
  clover: "Clover",
  app_thru: "App Thru",
  vlink: "Vlink",
  tiffingo: "TiffinGo",
  uber_eats: "Uber Eats",
  doordash: "DoorDash",
  skip: "Skip",
  other: "Other",
};

const COLOR: Record<string, string> = {
  counter: "bg-[#f3eee6] text-[#5b3a1e]",
  clover: "bg-emerald-100 text-emerald-800",
  app_thru: "bg-amber-100 text-amber-900",
  vlink: "bg-orange-100 text-orange-800",
  tiffingo: "bg-lime-100 text-lime-800",
  uber_eats: "bg-green-100 text-green-900",
  doordash: "bg-red-100 text-red-800",
  skip: "bg-orange-200 text-orange-900",
  other: "bg-gray-100 text-gray-700",
};

export function ChannelBadge({ channel }: { channel: string }) {
  return <span className={`badge !ml-0 ${COLOR[channel] ?? COLOR.other}`}>{CHANNEL_LABEL[channel] ?? channel}</span>;
}

export const DIRECT_CHANNELS = ["counter", "clover", "app_thru", "vlink", "tiffingo"];
