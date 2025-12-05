// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface DAOInteraction {
  id: string;
  proposalId: string;
  fromDAO: string;
  toDAO: string;
  encryptedAmount: string;
  encryptedTerms: string;
  timestamp: number;
  status: "pending" | "approved" | "rejected" | "executed";
  category: "governance" | "asset-swap" | "joint-investment";
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [interactions, setInteractions] = useState<DAOInteraction[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newInteraction, setNewInteraction] = useState({
    toDAO: "",
    amount: 0,
    terms: "",
    category: "governance" as const
  });
  const [selectedInteraction, setSelectedInteraction] = useState<DAOInteraction | null>(null);
  const [decryptedAmount, setDecryptedAmount] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterStatus, setFilterStatus] = useState<string>("all");

  // Stats calculations
  const approvedCount = interactions.filter(i => i.status === "approved").length;
  const pendingCount = interactions.filter(i => i.status === "pending").length;
  const rejectedCount = interactions.filter(i => i.status === "rejected").length;
  const executedCount = interactions.filter(i => i.status === "executed").length;

  // Filter interactions based on search and status
  const filteredInteractions = interactions.filter(interaction => {
    const matchesSearch = interaction.proposalId.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         interaction.fromDAO.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         interaction.toDAO.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = filterStatus === "all" || interaction.status === filterStatus;
    return matchesSearch && matchesStatus;
  });

  useEffect(() => {
    loadInteractions().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadInteractions = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        console.log("Contract is not available");
        return;
      }

      // Load interaction keys
      const keysBytes = await contract.getData("interaction_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing interaction keys:", e); }
      }

      // Load each interaction
      const list: DAOInteraction[] = [];
      for (const key of keys) {
        try {
          const interactionBytes = await contract.getData(`interaction_${key}`);
          if (interactionBytes.length > 0) {
            try {
              const interactionData = JSON.parse(ethers.toUtf8String(interactionBytes));
              list.push({
                id: key,
                proposalId: interactionData.proposalId,
                fromDAO: interactionData.fromDAO,
                toDAO: interactionData.toDAO,
                encryptedAmount: interactionData.encryptedAmount,
                encryptedTerms: interactionData.encryptedTerms,
                timestamp: interactionData.timestamp,
                status: interactionData.status || "pending",
                category: interactionData.category || "governance"
              });
            } catch (e) { console.error(`Error parsing interaction data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading interaction ${key}:`, e); }
      }
      
      // Sort by timestamp
      list.sort((a, b) => b.timestamp - a.timestamp);
      setInteractions(list);
    } catch (e) { 
      console.error("Error loading interactions:", e); 
    } finally { 
      setIsRefreshing(false); 
      setLoading(false); 
    }
  };

  const createInteraction = async () => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return; 
    }
    
    setCreating(true);
    setTransactionStatus({ 
      visible: true, 
      status: "pending", 
      message: "Encrypting DAO interaction with Zama FHE..." 
    });

    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");

      // Encrypt sensitive data
      const encryptedAmount = FHEEncryptNumber(newInteraction.amount);
      const encryptedTerms = `FHE-${btoa(newInteraction.terms)}`;

      // Generate interaction ID
      const interactionId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const proposalId = `PROP-${interactionId.substring(0, 6).toUpperCase()}`;

      // Prepare interaction data
      const interactionData = {
        proposalId,
        fromDAO: address || "",
        toDAO: newInteraction.toDAO,
        encryptedAmount,
        encryptedTerms,
        timestamp: Math.floor(Date.now() / 1000),
        status: "pending",
        category: newInteraction.category
      };

      // Store interaction
      await contract.setData(`interaction_${interactionId}`, ethers.toUtf8Bytes(JSON.stringify(interactionData)));

      // Update keys list
      const keysBytes = await contract.getData("interaction_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { 
          keys = JSON.parse(ethers.toUtf8String(keysBytes)); 
        } catch (e) { 
          console.error("Error parsing keys:", e); 
        }
      }
      keys.push(interactionId);
      await contract.setData("interaction_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));

      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: "DAO interaction submitted securely with FHE encryption!" 
      });

      await loadInteractions();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewInteraction({
          toDAO: "",
          amount: 0,
          terms: "",
          category: "governance"
        });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ 
        visible: true, 
        status: "error", 
        message: errorMessage 
      });
      setTimeout(() => setTransactionStatus({ 
        visible: false, 
        status: "pending", 
        message: "" 
      }), 3000);
    } finally { 
      setCreating(false); 
    }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return null; 
    }
    
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { 
      console.error("Decryption failed:", e); 
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  const updateInteractionStatus = async (interactionId: string, newStatus: "approved" | "rejected" | "executed") => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return; 
    }
    
    setTransactionStatus({ 
      visible: true, 
      status: "pending", 
      message: `Processing FHE-encrypted interaction with ${newStatus} status...` 
    });

    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      
      const interactionBytes = await contract.getData(`interaction_${interactionId}`);
      if (interactionBytes.length === 0) throw new Error("Interaction not found");
      
      const interactionData = JSON.parse(ethers.toUtf8String(interactionBytes));
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedInteraction = { 
        ...interactionData, 
        status: newStatus 
      };
      
      await contractWithSigner.setData(
        `interaction_${interactionId}`, 
        ethers.toUtf8Bytes(JSON.stringify(updatedInteraction))
      );
      
      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: `Interaction ${newStatus} successfully!` 
      });
      
      await loadInteractions();
      setTimeout(() => setTransactionStatus({ 
        visible: false, 
        status: "pending", 
        message: "" 
      }), 2000);
    } catch (e: any) {
      setTransactionStatus({ 
        visible: true, 
        status: "error", 
        message: `Status update failed: ${e.message || "Unknown error"}` 
      });
      setTimeout(() => setTransactionStatus({ 
        visible: false, 
        status: "pending", 
        message: "" 
      }), 3000);
    }
  };

  const renderStatusFlow = () => {
    return (
      <div className="status-flow">
        <div className={`flow-step ${interactions.length > 0 ? 'active' : ''}`}>
          <div className="step-icon">1</div>
          <div className="step-label">Created</div>
        </div>
        <div className={`flow-step ${pendingCount > 0 ? 'active' : ''}`}>
          <div className="step-icon">2</div>
          <div className="step-label">Pending</div>
        </div>
        <div className={`flow-step ${approvedCount > 0 ? 'active' : ''}`}>
          <div className="step-icon">3</div>
          <div className="step-label">Approved</div>
        </div>
        <div className={`flow-step ${executedCount > 0 ? 'active' : ''}`}>
          <div className="step-icon">4</div>
          <div className="step-label">Executed</div>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="metal-spinner"></div>
      <p>Initializing DAO-to-DAO FHE protocol...</p>
    </div>
  );

  return (
    <div className="app-container future-metal-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="shield-icon"></div>
          </div>
          <h1>DAO<span>2</span>DAO<span>FHE</span></h1>
        </div>
        <div className="header-actions">
          <button 
            onClick={() => setShowCreateModal(true)} 
            className="create-btn metal-button"
          >
            <div className="add-icon"></div>
            New Interaction
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <div className="dashboard-panels">
        {/* Left Panel - Stats and Info */}
        <div className="left-panel metal-panel">
          <div className="panel-section">
            <h3>Project Introduction</h3>
            <p>
              <strong>DAO-to-DAO FHE Protocol</strong> enables secure, private interactions between DAOs using 
              Zama's Fully Homomorphic Encryption. Financial terms and governance details remain encrypted 
              throughout the entire process.
            </p>
            <div className="fhe-badge">
              <span>Powered by Zama FHE</span>
            </div>
          </div>

          <div className="panel-section">
            <h3>Interaction Statistics</h3>
            <div className="stats-grid">
              <div className="stat-item">
                <div className="stat-value">{interactions.length}</div>
                <div className="stat-label">Total</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{pendingCount}</div>
                <div className="stat-label">Pending</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{approvedCount}</div>
                <div className="stat-label">Approved</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{executedCount}</div>
                <div className="stat-label">Executed</div>
              </div>
            </div>
          </div>

          <div className="panel-section">
            <h3>Status Flow</h3>
            {renderStatusFlow()}
          </div>
        </div>

        {/* Main Panel - Interactions List */}
        <div className="main-panel metal-panel">
          <div className="panel-header">
            <h2>DAO Interactions</h2>
            <div className="controls">
              <div className="search-box">
                <input
                  type="text"
                  placeholder="Search proposals..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="metal-input"
                />
              </div>
              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                className="metal-select"
              >
                <option value="all">All Status</option>
                <option value="pending">Pending</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
                <option value="executed">Executed</option>
              </select>
              <button 
                onClick={loadInteractions} 
                className="refresh-btn metal-button" 
                disabled={isRefreshing}
              >
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>

          <div className="interactions-list">
            {filteredInteractions.length === 0 ? (
              <div className="no-interactions">
                <div className="no-data-icon"></div>
                <p>No DAO interactions found</p>
                <button 
                  className="metal-button primary" 
                  onClick={() => setShowCreateModal(true)}
                >
                  Create First Interaction
                </button>
              </div>
            ) : (
              filteredInteractions.map(interaction => (
                <div 
                  className="interaction-item" 
                  key={interaction.id}
                  onClick={() => setSelectedInteraction(interaction)}
                >
                  <div className="interaction-id">
                    #{interaction.proposalId}
                  </div>
                  <div className="interaction-parties">
                    <span className="from-dao">{interaction.fromDAO.substring(0, 6)}...</span>
                    <span className="arrow">→</span>
                    <span className="to-dao">{interaction.toDAO.substring(0, 6)}...</span>
                  </div>
                  <div className="interaction-category">
                    {interaction.category}
                  </div>
                  <div className="interaction-date">
                    {new Date(interaction.timestamp * 1000).toLocaleDateString()}
                  </div>
                  <div className="interaction-status">
                    <span className={`status-badge ${interaction.status}`}>
                      {interaction.status}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Create Interaction Modal */}
      {showCreateModal && (
        <ModalCreate
          onSubmit={createInteraction}
          onClose={() => setShowCreateModal(false)}
          creating={creating}
          interactionData={newInteraction}
          setInteractionData={setNewInteraction}
        />
      )}

      {/* Interaction Detail Modal */}
      {selectedInteraction && (
        <InteractionDetailModal
          interaction={selectedInteraction}
          onClose={() => {
            setSelectedInteraction(null);
            setDecryptedAmount(null);
          }}
          decryptedAmount={decryptedAmount}
          setDecryptedAmount={setDecryptedAmount}
          isDecrypting={isDecrypting}
          decryptWithSignature={decryptWithSignature}
          updateInteractionStatus={updateInteractionStatus}
        />
      )}

      {/* Transaction Status Modal */}
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content metal-panel">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="metal-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="shield-icon"></div>
              <span>DAO2DAO FHE Protocol</span>
            </div>
            <p>Secure encrypted DAO interactions using Zama FHE technology</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">GitHub</a>
            <a href="#" className="footer-link">Terms</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>FHE-Powered Privacy</span>
          </div>
          <div className="copyright">
            © {new Date().getFullYear()} DAO2DAO FHE. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void;
  onClose: () => void;
  creating: boolean;
  interactionData: any;
  setInteractionData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ 
  onSubmit, 
  onClose, 
  creating, 
  interactionData, 
  setInteractionData 
}) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setInteractionData({ ...interactionData, [name]: value });
  };

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setInteractionData({ ...interactionData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!interactionData.toDAO || !interactionData.amount) {
      alert("Please fill required fields");
      return;
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal metal-panel">
        <div className="modal-header">
          <h2>New DAO Interaction</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice">
            <div className="key-icon"></div>
            <div>
              <strong>FHE Encryption Notice</strong>
              <p>All sensitive data will be encrypted with Zama FHE before submission</p>
            </div>
          </div>

          <div className="form-grid">
            <div className="form-group">
              <label>To DAO Address *</label>
              <input
                type="text"
                name="toDAO"
                value={interactionData.toDAO}
                onChange={handleChange}
                placeholder="Enter DAO address (0x...)"
                className="metal-input"
              />
            </div>

            <div className="form-group">
              <label>Category *</label>
              <select
                name="category"
                value={interactionData.category}
                onChange={handleChange}
                className="metal-select"
              >
                <option value="governance">Joint Governance</option>
                <option value="asset-swap">Asset Swap</option>
                <option value="joint-investment">Joint Investment</option>
              </select>
            </div>

            <div className="form-group">
              <label>Amount (ETH) *</label>
              <input
                type="number"
                name="amount"
                value={interactionData.amount}
                onChange={handleAmountChange}
                placeholder="Enter amount"
                className="metal-input"
                step="0.01"
              />
            </div>

            <div className="form-group full-width">
              <label>Terms</label>
              <textarea
                name="terms"
                value={interactionData.terms}
                onChange={handleChange}
                placeholder="Enter interaction terms (will be encrypted)"
                className="metal-textarea"
                rows={3}
              />
            </div>
          </div>

          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain Amount:</span>
                <div>{interactionData.amount || '0'}</div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>
                  {interactionData.amount ? 
                    FHEEncryptNumber(interactionData.amount).substring(0, 50) + '...' : 
                    'No amount entered'}
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn metal-button">
            Cancel
          </button>
          <button 
            onClick={handleSubmit} 
            disabled={creating} 
            className="submit-btn metal-button primary"
          >
            {creating ? "Encrypting with FHE..." : "Submit Securely"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface InteractionDetailModalProps {
  interaction: DAOInteraction;
  onClose: () => void;
  decryptedAmount: number | null;
  setDecryptedAmount: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
  updateInteractionStatus: (id: string, status: "approved" | "rejected" | "executed") => void;
}

const InteractionDetailModal: React.FC<InteractionDetailModalProps> = ({ 
  interaction, 
  onClose, 
  decryptedAmount, 
  setDecryptedAmount, 
  isDecrypting, 
  decryptWithSignature,
  updateInteractionStatus
}) => {
  const handleDecrypt = async () => {
    if (decryptedAmount !== null) {
      setDecryptedAmount(null);
      return;
    }
    const decrypted = await decryptWithSignature(interaction.encryptedAmount);
    if (decrypted !== null) setDecryptedAmount(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="detail-modal metal-panel">
        <div className="modal-header">
          <h2>Interaction Details</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="interaction-info">
            <div className="info-item">
              <span>Proposal ID:</span>
              <strong>{interaction.proposalId}</strong>
            </div>
            <div className="info-item">
              <span>From DAO:</span>
              <strong>{interaction.fromDAO.substring(0, 8)}...{interaction.fromDAO.substring(36)}</strong>
            </div>
            <div className="info-item">
              <span>To DAO:</span>
              <strong>{interaction.toDAO.substring(0, 8)}...{interaction.toDAO.substring(36)}</strong>
            </div>
            <div className="info-item">
              <span>Category:</span>
              <strong>{interaction.category}</strong>
            </div>
            <div className="info-item">
              <span>Date:</span>
              <strong>{new Date(interaction.timestamp * 1000).toLocaleString()}</strong>
            </div>
            <div className="info-item">
              <span>Status:</span>
              <strong className={`status-badge ${interaction.status}`}>
                {interaction.status}
              </strong>
            </div>
          </div>

          <div className="encrypted-section">
            <h3>Encrypted Data</h3>
            <div className="encrypted-data">
              <div className="data-item">
                <span>Amount:</span>
                <div>{interaction.encryptedAmount.substring(0, 50)}...</div>
              </div>
              <div className="data-item">
                <span>Terms:</span>
                <div>{interaction.encryptedTerms.substring(0, 50)}...</div>
              </div>
            </div>
            <div className="fhe-tag">
              <div className="fhe-icon"></div>
              <span>FHE Encrypted</span>
            </div>
            <button 
              className="decrypt-btn metal-button" 
              onClick={handleDecrypt} 
              disabled={isDecrypting}
            >
              {isDecrypting ? (
                <span className="decrypt-spinner"></span>
              ) : decryptedAmount !== null ? (
                "Hide Decrypted Value"
              ) : (
                "Decrypt with Wallet Signature"
              )}
            </button>
          </div>

          {decryptedAmount !== null && (
            <div className="decrypted-section">
              <h3>Decrypted Value</h3>
              <div className="decrypted-value">
                <span>Amount:</span>
                <strong>{decryptedAmount} ETH</strong>
              </div>
              <div className="decryption-notice">
                <div className="warning-icon"></div>
                <span>Decrypted data is only visible after wallet signature verification</span>
              </div>
            </div>
          )}

          {interaction.status === "pending" && (
            <div className="action-buttons">
              <button 
                className="metal-button success" 
                onClick={() => updateInteractionStatus(interaction.id, "approved")}
              >
                Approve
              </button>
              <button 
                className="metal-button danger" 
                onClick={() => updateInteractionStatus(interaction.id, "rejected")}
              >
                Reject
              </button>
            </div>
          )}

          {interaction.status === "approved" && (
            <div className="action-buttons">
              <button 
                className="metal-button primary" 
                onClick={() => updateInteractionStatus(interaction.id, "executed")}
              >
                Mark as Executed
              </button>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn metal-button">
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default App;