import { LoaderCircle } from 'lucide'
import { Icon } from '../../components/Icon'

export function LoadingScreen() {
  return (
    <div className="loading-screen" role="status" aria-live="polite">
      <Icon icon={LoaderCircle} className="loading-icon" />
      <span>Loading scene</span>
    </div>
  )
}
