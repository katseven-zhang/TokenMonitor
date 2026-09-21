import { Component, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, RotateCcw, X } from 'lucide-react';

// One place that tells the user a region failed and how to get out of it, instead of
// the previous behaviour where any throw inside a panel replaced the whole app with a
// blank page.
//
// `title` is copy the caller already translated; `label` names the guarded region and is
// placed into `errors.region_failed` here, because a class component cannot read the
// active language and the boundary has to render its own heading.
export function FailureNotice({title,label,message,onRetry,onClose}:{title?:string;label?:string;message:string;onRetry?:()=>void;onClose?:()=>void}) {
  const {t}=useTranslation();
  const heading=title??(label?t('errors.region_failed',{label}):t('errors.region_default'));
  return <div role="alert" className="panel">
    <div className="panel-heading"><h2><AlertTriangle size={16}/> {heading}</h2>{onRetry&&<button className="secondary" onClick={onRetry}><RotateCcw size={14}/>{t('errors.retry')}</button>}{onClose&&<button className="icon-button" aria-label={t('errors.close_region')} onClick={onClose}><X size={15}/></button>}</div>
    <p className="error-text">{message}</p>
  </div>;
}

type Props = { children:ReactNode; label?:string; onRetry?:()=>void; onClose?:()=>void };
type State = { error: Error|null };

export class ErrorBoundary extends Component<Props,State> {
  state:State = { error:null };
  static getDerivedStateFromError(error:Error):State { return { error }; }
  private retry = () => { this.setState({ error:null }); this.props.onRetry?.(); };
  render() {
    const error = this.state.error;
    if (!error) return this.props.children;
    return <FailureNotice label={this.props.label} message={error.message || String(error)} onRetry={this.retry} onClose={this.props.onClose}/>;
  }
}
