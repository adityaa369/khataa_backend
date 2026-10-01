import sys

with open('controllers/auth.js', 'r', encoding='utf-8') as f:
    content = f.read()

target = '''        } else {
            user = await User.findOneAndUpdate(
                { phone: phoneStr },
                { set: updates },
                { new: true }
            );
        }

        res.status(200).json({
            success: true,
            user
        });'''

repl = '''        } else {
            user = await User.findOneAndUpdate(
                { phone: phoneStr },
                { set: updates },
                { new: true }
            );
        }

        // Ensure legacy users have an id field
        if (!user.id) {
            user.id = crypto.randomUUID();
            await user.save();
        }

        const jwt = require('jsonwebtoken');
        const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
            expiresIn: '30d'
        });

        res.status(200).json({
            success: true,
            token,
            user
        });'''

target = target.replace('', '$')
repl = repl.replace('', '$')

if target in content:
    content = content.replace(target, repl)
    with open('controllers/auth.js', 'w', encoding='utf-8') as f:
        f.write(content)
    print('Replaced successfully')
else:
    print('Target not found')
