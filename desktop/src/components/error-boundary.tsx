import { Component, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw, X } from 'lucide-react';

// One place that tells the user a region failed and how to get out of it, instead of
// the previous behaviour where any throw inside a panel replaced the whole app with a
// blank page.
export function FailureNotice({title='这一栏暂时无法显示',message,onRetry,onClose}:{title?:string;message:string;onRetry?:()=>void;onClose?:()=>void}) {
  return <div role="alert" className="panel">
    <div className="panel-heading"><h2><AlertTriangle size={16}/> {title}</h2>{onRetry&&<button className="secondary" onClick={onRetry}><RotateCcw size={14}/>重试</button>}{onClose&&<button className="icon-button" aria-label="关闭此栏" onClick={onClose}><X size={15}/></button>}</div>
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
    return <FailureNotice
      title={this.props.label ? `${this.props.label}无法显示` : undefined}
      message={error.message || String(error)}
      onRetry={this.retry}
      onClose={this.props.onClose}
    />;
  }
}
