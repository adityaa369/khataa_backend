const axios = require('axios');

const sendOtp = async (phone, otp) => {
    try {
        // Sanitize: strip any non-digits and leading +91 or 91
        const cleanPhone = phone.toString().replace(/\D/g, '').replace(/^91/, '');
        console.log(`[MSG91] Attempting to send OTP ${otp} to 91${cleanPhone}...`);

        const templateId = process.env.MSG91_TEMPLATE_ID;
        const authkey = process.env.MSG91_AUTH_KEY;

        // Use POST with JSON body
        // removing 'sender' to let MSG91 use the one linked to the template ID (DLT)
        const response = await axios.post(`https://api.msg91.com/api/v5/otp`, {
            template_id: templateId,
            mobile: `91${cleanPhone}`,
            authkey: authkey,
            otp: otp
        }, {
            headers: {
                'Content-Type': 'application/json'
            }
        });

        console.log('[MSG91] Send Response:', JSON.stringify(response.data));
        return { success: response.data.type === 'success', response: response.data };
    } catch (error) {
        const errorData = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error('[MSG91] Send OTP Error:', errorData);
        return { success: false, error: errorData };
    }
};

const verifyOtp = async (phone, otp) => {
    try {
        const cleanPhone = phone.toString().replace(/\D/g, '').replace(/^91/, '');
        const finalMobile = `91${cleanPhone}`;
        const payload = {
            mobile: finalMobile,
            otp: otp,
            authkey: process.env.MSG91_AUTH_KEY
        };
        console.log(`[MSG91] Attempting to verify OTP ${otp} for ${finalMobile} with payload:`, payload);

        const response = await axios.get(`https://api.msg91.com/api/v5/otp/verify`, {
            params: {
                mobile: finalMobile,
                otp: otp,
                authkey: process.env.MSG91_AUTH_KEY
            }
        });
        if (response.data.type === 'success') {
            return { success: true, response: response.data };
        }
        return { success: false, message: response.data.message };
    } catch (error) {
        console.error('MSG91 Verify OTP Error:', error.message);
        return { success: false, error: error.message };
    }
};

const verifyAccessToken = async (accessToken) => {
    try {
        const response = await axios.post('https://api.msg91.com/api/v5/widget/verifyAccessToken', {
            'access-token': accessToken
        }, {
            headers: {
                'authkey': process.env.MSG91_AUTH_KEY,
                'Content-Type': 'application/json'
            }
        });

        if (response.data.type === 'success') {
            const mobile = response.data.mobile_number ||
                response.data.mobile ||
                (typeof response.data.message === 'string' && response.data.message.length > 5 ? response.data.message : null);

            return {
                success: true,
                mobile: mobile,
                response: response.data
            };
        }
        return { success: false, message: response.data.message || 'Invalid token' };
    } catch (error) {
        console.error('MSG91 Verify Token Error:', error.message);
        return { success: false, error: error.message };
    }
};

module.exports = { sendOtp, verifyOtp, verifyAccessToken };
