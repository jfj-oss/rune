import { Hourglass } from 'lucide-react';
import { Empty } from '../components/Rows';

export default function Placeholder({ title }: { title: string }) {
  return (
    <div className="page">
      <header className="libhead"><div><h1 className="pagehead__title">{title}</h1></div></header>
      <Empty title="Coming soon" icon={<Hourglass size={28} />}>This view isn’t part of the first release yet.</Empty>
    </div>
  );
}
