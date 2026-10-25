/**
 * A listing's name, linking to its page on the consumer site in a new tab when
 * customers can open it there. `url` comes from the API, which applies the
 * consumer site's own visibility rule; when it is null (awaiting review,
 * ended, closed, rejected, or the organiser is suspended or hidden) the name
 * is plain text.
 */
export function ListingName({
  name,
  url,
  className = 'font-medium text-slate-900',
}: {
  name: string;
  url: string | null | undefined;
  className?: string;
}) {
  if (!url) {
    return (
      <span className={className} title="Customers can’t open this on circls.app right now">
        {name}
      </span>
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title="Open on circls.app"
      className={`${className} hover:underline`}
    >
      {name}
      <span aria-hidden className="ml-1 text-xs font-normal text-slate-400">↗</span>
    </a>
  );
}
