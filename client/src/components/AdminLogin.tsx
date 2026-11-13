import React, { useState } from 'react';
import { ShieldCheck, Lock, User, Eye, EyeOff, KeyRound, AlertCircle } from 'lucide-react';
import { loginAdmin, changeAdminPassword } from '../services/api';
import type { AuthState } from '../services/api';
import { useNotify } from './InAppNotifications';

interface AdminLoginProps {
  onLoginSuccess: (auth: AuthState) => void;
}

export const AdminLogin: React.FC<AdminLoginProps> = ({ onLoginSuccess }) => {
  const { notify } = useNotify();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setErrorMsg('Please enter both username and password.');
      return;
    }

    setErrorMsg(null);
    setIsSubmitting(true);
    try {
      const auth = await loginAdmin(username.trim(), password);
      notify(`Signed in as ${auth.username}.`, 'success', 'Admin Authenticated');
      onLoginSuccess(auth);
    } catch (err: any) {
      const msg = err.message || 'Authentication failed';
      setErrorMsg(msg);
      notify(msg, 'error', 'Login Failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="admin-login-page">
      <div className="admin-login-card">
        <div className="login-brand-header">
          <div className="login-shield-badge">
            <ShieldCheck size={28} />
          </div>
          <h1>SmartHouse<span>Studio</span></h1>
          <p>Researcher Admin Console Sign In</p>
        </div>

        {errorMsg && (
          <div className="login-error-banner" role="alert">
            <AlertCircle size={16} />
            <span>{errorMsg}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="login-form">
          <div className="login-field">
            <label htmlFor="admin-username">Researcher Username</label>
            <div className="login-input-wrap">
              <User size={16} className="login-input-icon" />
              <input
                id="admin-username"
                type="text"
                autoComplete="username"
                className="ui-input login-input"
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder="admin"
                required
              />
            </div>
          </div>

          <div className="login-field">
            <label htmlFor="admin-password">Password</label>
            <div className="login-input-wrap">
              <Lock size={16} className="login-input-icon" />
              <input
                id="admin-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                className="ui-input login-input login-input-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Enter admin password"
                required
                autoFocus
              />
              <button
                type="button"
                className="password-eye-btn"
                onClick={() => setShowPassword(v => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <button type="submit" className="btn-ui btn-ui-primary btn-full login-submit-btn" disabled={isSubmitting}>
            <ShieldCheck size={17} />
            <span>{isSubmitting ? 'Verifying...' : 'Sign In to Admin Console'}</span>
          </button>
        </form>

        <div className="login-footer-note">
          Participant mobile devices require a tokenized invite link from the Admin Console after sign in.
        </div>
      </div>
    </div>
  );
};

interface ChangePasswordModalProps {
  onClose: () => void;
  onSuccess: () => void;
}

export const ChangePasswordModal: React.FC<ChangePasswordModalProps> = ({ onClose, onSuccess }) => {
  const { notify } = useNotify();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 8) {
      setErrorMsg('New password must be at least 8 characters long.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setErrorMsg('New password and confirmation do not match.');
      return;
    }

    setErrorMsg(null);
    setIsSaving(true);
    try {
      await changeAdminPassword(currentPassword, newPassword);
      notify('Admin password updated successfully.', 'success', 'Password Changed');
      onSuccess();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to update password');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="inapp-confirm-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="pw-modal-title">
      <div className="inapp-confirm-modal pw-modal" onClick={e => e.stopPropagation()}>
        <div className="inapp-confirm-icon-wrap confirm-primary">
          <KeyRound size={22} />
        </div>
        <h3 id="pw-modal-title">Update Admin Password</h3>
        <p className="inapp-confirm-msg">Set a strong researcher password (minimum 8 characters).</p>

        {errorMsg && (
          <div className="login-error-banner" role="alert">
            <AlertCircle size={15} />
            <span>{errorMsg}</span>
          </div>
        )}

        <form onSubmit={handleSave} className="pw-modal-form">
          <input
            type="password"
            className="ui-input"
            placeholder="Current password"
            value={currentPassword}
            onChange={e => setCurrentPassword(e.target.value)}
            required
          />
          <input
            type="password"
            className="ui-input"
            placeholder="New password (min 8 chars)"
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
            required
          />
          <input
            type="password"
            className="ui-input"
            placeholder="Confirm new password"
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            required
          />

          <div className="inapp-confirm-actions">
            <button type="button" className="btn-ui btn-ui-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-ui btn-ui-primary" disabled={isSaving}>
              {isSaving ? 'Updating...' : 'Save Password'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
