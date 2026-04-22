const mongoose = require('mongoose');

const campaignSchema = new mongoose.Schema({
  name: { type: String, required: true },
  template: { type: String, required: true },
  audienceFilter: { type: mongoose.Schema.Types.Mixed, default: {} },
  status: { type: String, enum: ['Draft', 'Running', 'Completed', 'Failed'], default: 'Draft' },
  totalContacts: { type: Number, default: 0 },
  sentCount: { type: Number, default: 0 },
  failedCount: { type: Number, default: 0 },
  pendingCount: { type: Number, default: 0 }
}, {
  timestamps: true
});

campaignSchema.index({ createdAt: -1, _id: -1 });

module.exports = mongoose.model('Campaign', campaignSchema);
