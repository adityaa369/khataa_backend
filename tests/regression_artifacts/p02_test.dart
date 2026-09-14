import 'dart:convert';
import 'package:http/http.dart' as http;

void main() async {
  // 1. Send OTP via Firebase (Simulated)
  final phone = '9999999990';
  final idToken = 'mockToken_$phone';
  
  // 2. Verify OTP
  final verifyRes = await http.post(
    Uri.parse('http://localhost:5000/api/auth/verify-otp'),
    headers: {'Content-Type': 'application/json'},
    body: jsonEncode({'idToken': idToken, 'phone': phone})
  );
  
  print('Verify OTP: ${verifyRes.statusCode} ${verifyRes.body}');
  if (verifyRes.statusCode != 200) return;
  
  final token = jsonDecode(verifyRes.body)['token'];
  
  // 3. Save Personal Details
  final profileRes1 = await http.put(
    Uri.parse('http://localhost:5000/api/users/profile'),
    headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $token'},
    body: jsonEncode({
      'firstName': 'John',
      'lastName': 'Doe',
      'email': 'john@example.com',
      'phone': phone
    })
  );
  print('Profile 1: ${profileRes1.statusCode} ${profileRes1.body}');
  
  // 4. Save PAN Details
  final profileRes2 = await http.put(
    Uri.parse('http://localhost:5000/api/users/profile'),
    headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $token'},
    body: jsonEncode({
      'pan': 'ABCDE1234F',
      'aadhar': '123456789012',
      'dob': '01/01/1990',
      'gender': 'Male'
    })
  );
  print('Profile 2: ${profileRes2.statusCode} ${profileRes2.body}');
}
