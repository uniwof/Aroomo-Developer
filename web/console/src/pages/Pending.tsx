/** 等后台线 API 的页面先占位（PROGRESS「控制台需要的 API」）；原 Shell 页面按页迁过来。 */
export function Pending({ title, note }: { title: string; note: string }) {
  return (
    <section aria-labelledby="pending-title" className="space-y-2">
      <h1 id="pending-title" className="text-[20px] font-semibold">
        {title}
      </h1>
      <p className="text-[var(--muted)]">{note}</p>
    </section>
  );
}
