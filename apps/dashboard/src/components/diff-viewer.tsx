interface DiffViewerProps {
  diff: string;
}

export function DiffViewer({ diff }: DiffViewerProps) {
  const lines = diff.split('\n');

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-navy font-mono text-xs">
      {lines.map((line, i) => {
        let lineClass = 'text-cream/80';
        if (line.startsWith('+') && !line.startsWith('+++'))
          lineClass = 'text-status-success bg-status-success/10';
        else if (line.startsWith('-') && !line.startsWith('---'))
          lineClass = 'text-status-failed bg-status-failed/10';
        else if (line.startsWith('@@')) lineClass = 'text-orange bg-orange/10';
        else if (line.startsWith('diff') || line.startsWith('index')) lineClass = 'text-gray-muted';

        return (
          <div key={i} className={`px-4 py-0.5 ${lineClass}`}>
            {line || ' '}
          </div>
        );
      })}
    </div>
  );
}
