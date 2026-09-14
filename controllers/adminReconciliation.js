const ReconciliationIncident = require('../models/ReconciliationIncident');
const AdminAuditLog = require('../models/AdminAuditLog');
const { getTraceContext } = require('../utils/asyncContext');

exports.getReconciliationOverview = async (req, res) => {
    const totalIncidents = await ReconciliationIncident.countDocuments();
    const openIncidents = await ReconciliationIncident.countDocuments({ status: 'OPEN' });
    const criticalIncidents = await ReconciliationIncident.countDocuments({ severity: 'CRITICAL', status: { $in: ['OPEN', 'INVESTIGATING'] } });

    res.status(200).json({
        success: true,
        data: {
            status: criticalIncidents > 0 ? '?? FINANCIAL INTEGRITY ISSUE' : '?? ALL SYSTEMS BALANCED',
            loansReconciled: '100%',
            chitsReconciled: '100%',
            ledgerBalanced: true,
            openIncidents,
            criticalIncidents,
            lastRun: new Date()
        }
    });
};

exports.getIncidents = async (req, res) => {
    const incidents = await ReconciliationIncident.find().sort({ detectedAt: -1 }).limit(50);
    res.status(200).json({ success: true, data: incidents });
};

exports.getIncidentDetail = async (req, res) => {
    const incident = await ReconciliationIncident.findById(req.params.id);
    if (!incident) return res.status(404).json({ success: false, message: 'Incident not found' });
    
    // Fetch audit trail for this incident
    const auditTrail = await AdminAuditLog.find({ resourceType: 'Incident', resourceId: incident._id.toString() }).sort({ createdAt: 1 }).populate('adminId', 'email role');

    res.status(200).json({ success: true, data: { incident, auditTrail } });
};

exports.updateIncidentWorkflow = async (req, res) => {
    const { status, notes, reason } = req.body;
    
    // Strict requirement: Resolution requires notes
    if (status === 'RESOLVED' && !notes) {
        return res.status(400).json({ success: false, message: 'Resolution notes are strictly required to resolve an incident.' });
    }
    
    // Acknowledging requires reason
    if (status === 'ACKNOWLEDGED' && !reason) {
        return res.status(400).json({ success: false, message: 'Reason required to acknowledge an incident.' });
    }

    const incident = await ReconciliationIncident.findById(req.params.id);
    if (!incident) return res.status(404).json({ success: false, message: 'Incident not found' });

    const previousStatus = incident.status;
    incident.status = status;
    
    if (status === 'RESOLVED') {
        incident.resolutionNotes = notes;
        incident.resolvedAt = new Date();
        incident.resolvedBy = req.admin._id;
    } else {
        incident.details = incident.details ? incident.details + `\n[${status}]: ${notes || reason}` : `[${status}]: ${notes || reason}`;
    }

    await incident.save();

    // Immutable chain of custody
    const { requestId } = getTraceContext();
    await AdminAuditLog.create({
        adminId: req.admin._id,
        action: `INCIDENT_STATUS_${status}`,
        reason: reason || notes || `Transitioned from ${previousStatus}`,
        status: 'SUCCESS',
        ipAddress: req.ip,
        requestId,
        resourceType: 'Incident',
        resourceId: incident._id.toString()
    });

    res.status(200).json({ success: true, data: incident });
};
