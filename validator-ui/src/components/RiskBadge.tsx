import clsx from 'clsx'

export function RiskBadge({ score, level }: { score: number; level: 'low' | 'medium' | 'high' }) {
  return (
    <span className={clsx('risk-badge', {
      'risk-badge--low': level === 'low',
      'risk-badge--medium': level === 'medium',
      'risk-badge--high': level === 'high',
    })}>
      <span className="text-[14px] font-light">{(score * 100).toFixed(0)}</span>
      <span>{level}</span>
    </span>
  )
}

export function ProofBadge({ status }: { status: 'verified' | 'commitments_only' }) {
  return (
    <span className={clsx('proof-badge', {
      'proof-badge--verified': status === 'verified',
      'proof-badge--commitments': status === 'commitments_only',
    })}>
      {status === 'verified' ? 'VERIFIED' : 'COMMITMENTS ONLY'}
    </span>
  )
}
