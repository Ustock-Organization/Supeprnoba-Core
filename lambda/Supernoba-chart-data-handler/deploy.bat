@echo off
echo Deploying Supernoba-chart-data-handler Lambda...
"C:\Program Files\Amazon\AWSCLIV2\aws.exe" lambda update-function-code --function-name Supernoba-chart-data-handler --zip-file fileb://chart-handler.zip
echo Done!
pause
