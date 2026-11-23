from django.db import migrations, models

class Migration(migrations.Migration):
    dependencies = [('accounts', '0003_aiconsent')]
    operations = [migrations.CreateModel(name='CoachingRateBucket',fields=[('key',models.CharField(max_length=120,primary_key=True,serialize=False)),('count',models.PositiveIntegerField(default=0))])]
