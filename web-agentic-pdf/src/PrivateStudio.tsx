import { Component, type ReactNode } from 'react';
import App from './App';
import './App.css';

export class StudioErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <main className="studio"><section className="private-entry"><h1>Let’s reopen the studio.</h1><p>An unexpected error interrupted this view. Saved cloud documents have not been deleted.</p><button className="primary-ice-btn" onClick={() => location.reload()}>Reload studio</button></section></main> : this.props.children; }
}
export default function PrivateStudio() {
  return <App />;
}
