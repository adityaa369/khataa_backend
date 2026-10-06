const fs = require('fs');

let content = fs.readFileSync('controllers/loans.js', 'utf8');

const newFunc = \exports.downloadNoc = async (req, res) => {
    try {
        const PDFDocument = require('pdfkit');
        const Loan = require('../models/Loan');
        const loan = await Loan.findById(req.params.id);
        
        if (!loan) {
            return res.status(404).json({ success: false, message: 'Loan not found' });
        }
        
        if (loan.lender.toString() !== req.user.id && loan.borrower.toString() !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Not authorized' });
        }

        if (loan.status !== 'completed' && loan.status !== 'closed') {
            return res.status(400).json({ success: false, message: 'Loan is not fully paid yet' });
        }

        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="NOC_' + loan._id + '.pdf"');
        
        doc.pipe(res);

        doc.fontSize(24).font('Helvetica-Bold').text('NO DUES CERTIFICATE', { align: 'center' });
        doc.moveDown();
        doc.fontSize(12).font('Helvetica').text('Date: ' + new Date().toLocaleDateString(), { align: 'right' });
        doc.moveDown(2);
        
        doc.fontSize(14).font('Helvetica-Bold').text('To Whom It May Concern,');
        doc.moveDown();
        
        const borrowerName = loan.borrowerName || 'Borrower';
        doc.fontSize(12).font('Helvetica').text(
            'This is to certify that the credit agreement (Reference ID: ' + loan._id + ') between ' +
            'the Lender and the Borrower (' + borrowerName + ') has been fully settled.'
        );
        doc.moveDown();
        
        doc.rect(50, doc.y, 500, 150).stroke();
        doc.moveDown(0.5);
        doc.fontSize(12).font('Helvetica-Bold').text('Credit Details', { align: 'center' });
        doc.moveDown();
        doc.font('Helvetica').text('Principal Amount: ' + (loan.amount / 100) + ' INR', 70);
        doc.text('Total Paid: ' + (loan.paidAmount / 100) + ' INR', 70);
        const startDateStr = new Date(loan.startDate || loan.createdAt).toLocaleDateString();
        doc.text('Start Date: ' + startDateStr, 70);
        doc.moveDown(2);
        
        doc.fontSize(12).font('Helvetica').text(
            'This electronically generated document confirms that there are no outstanding dues remaining against this credit.',
            50
        );
        
        doc.moveDown(4);
        doc.font('Helvetica-Bold').text('Authorized Signatory', { align: 'right' });

        doc.end();
    } catch (err) {
        console.error(err);
        if (!res.headersSent) {
            res.status(500).json({ success: false, message: 'Failed to generate NOC' });
        }
    }
};\;

const parts = content.split('exports.downloadNoc = async (req, res) => {');
if (parts.length === 2) {
    fs.writeFileSync('controllers/loans.js', parts[0] + newFunc, 'utf8');
    console.log('Fixed successfully.');
} else {
    console.log('Could not find split point.');
}
