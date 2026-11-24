export interface PlaceholderProps {
  title: string;
  note: string; // build step that will fill this widget, e.g. "ขั้น 4"
}

export function Placeholder({ title, note }: PlaceholderProps) {
  return (
    <section className="cr-placeholder" aria-label={title}>
      <p className="cr-placeholder__title">{title}</p>
      <p className="cr-placeholder__note">ยังไม่เปิดให้ใช้ ({note})</p>
    </section>
  );
}
